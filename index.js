import { createServer } from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import 'dotenv/config';
import { RealtimeTranscriber } from 'assemblyai';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import fs from 'fs';
import util from 'util';
import { OpenAI } from 'openai';
// load environment variables
// https://stephenwalther.com/build-an-openai-assistant-app-with-nodejs-in-less-than-15-minutes/
const client = new TextToSpeechClient();
// GPT code 
const OpenAISecret = process.env.OPENAI_API_KEY;
const model = 'gpt-4o';
const openai = new OpenAI({apiKey: OpenAISecret});
const segmentMode = true; //streaming mode or waiting for full response
// global variables
const globalState = {}

const createRun =  async(thread_id) => {
    const run =
      await openai.beta.threads.runs.create(
        thread_id,
        {
          assistant_id: process.env.OPENAI_ASSISTANT_ID,
        },
      );
    return run.id;
}

const sleep = async(ms) => {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

const getRunResponse = async(run_id,thread_id) => {
    let openAiRunResponse = await openai.beta.threads.runs.retrieve(thread_id,run_id);

    while (openAiRunResponse.status !== 'completed') {
      await sleep(500);
      openAiRunResponse = await openai.beta.threads.runs.retrieve(thread_id,run_id);
    }

    const messages = await openai.beta.threads.messages.list(thread_id);
    const lastMessageForRun = messages.data
      .filter((message) => message.run_id === run_id && message.role === 'assistant')
      .pop();

    const status = lastMessageForRun ? 'completed' : '';
    const text = lastMessageForRun ?  lastMessageForRun.content[0].text.value : '';
    return {
        status: 'completed',
        content: text,
        run_id: run_id,
    };
}


const startStreamingRun = async(callSid,callback) => {

    const { threadId } = globalState[callSid];
    let aggregatedText = '';
    playResponseWorker(callSid);

    const run = openai.beta.threads.runs.stream(threadId, {
        assistant_id: process.env.OPENAI_ASSISTANT_ID,
    });
    
    run.on("event", (evt, data) => {
        //console.log(evt);
        if(evt.event == "thread.run.created"){
            console.log('run started');
        }

        if (evt.event == "thread.message.delta") {
            console.log(evt.data.delta.content[0].text.value);
            aggregatedText += evt.data.delta.content[0].text.value;
            if(segmentMode) {
                const pancuation = ['.','!','?',','];
                if(pancuation.includes(evt.data.delta.content[0].text.value.slice(-1))){
                    console.log('response = ',aggregatedText);
                    callback(aggregatedText);
                    aggregatedText = '';
                }
            }
        }
        if(evt.event == "thread.run.completed"){
            console.log('response left = ',aggregatedText);
            sayResponse(aggregatedText,callSid);
        }

        if(evt.event == "thread.message.incomplete"){

        }
        
        if(evt.event == "thread.message.cancelled"){

        }
    });
    const result = await run.finalRun();
    console.log('final run result = ',result);
    if(result.status === 'requires_action'){
       //patch - let's kill this run id, as we don't want to implement tool functions for now
        console.log('run requires action');
        openai.beta.threads.runs.cancel(threadId,result.id);
    }
    return run;
}

async function textToSpeech(text, outputFileName) {
    const request = {
        input: {text: text},
        voice: {languageCode: 'en-US', ssmlGender: 'NEUTRAL'},
        audioConfig: {audioEncoding: 'MULAW', sampleRateHertz: 8000},
    };
    const [response] = await client.synthesizeSpeech(request);
    const writeFile = util.promisify(fs.writeFile);
    await writeFile(outputFileName, response.audioContent, 'binary');
    console.log(`Audio content written to file: ${outputFileName}`);
}

function convertAudio(inputFileName) {
    const readFile = util.promisify(fs.readFile);
    return fs.readFileSync(inputFileName);
}


const app = express();
const server = createServer(app);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.get('/', (_, res) => res.type('text').send('Twilio media stream transcriber'));
// Tell Twilio to say something and then establish a media stream with the WebSocket server

app.post('/', async (req, res) => {
  const voiceModel = 'Google.en-US-Neural2-F';
  const thread = await openai.beta.threads.create();
  console.log('started call with thread id',thread.id);
  const run_id = await createRun(thread.id);
  const opening = await getRunResponse(run_id,thread.id);
  const callSid = req.body.CallSid;
  const url = `${process.env.SOCKET_URL}?callSid=${callSid}`;
  console.log('socket url = ',url);
  globalState[callSid] = {
    threadId: thread.id,
    streamSid: '',
    runId: run_id,
    playStack: [],
    active: true,
    connection: null
  }
  res.type('xml')
    .send(
      `<Response>
        <Say voice='${voiceModel}'>${opening.content}</Say>
        <Connect>
          <Stream url='${url}' />
        </Connect>
      </Response>`
    );
});


const addMessageToThread = async(callSid,text) => {
    const { threadId } = globalState[callSid];
    openai.beta.threads.messages.create(
        threadId,
        {
            role: "user",
            content: text
        }
    ).then(() => {
      startStreamingRun(callSid,(text) => { globalState[callSid].playStack.push(text); });
    }).catch((err) => {
        console.error('error adding message to thread',err);
    });
}


const playResponseWorker = async(callSid) => {
    while(globalState[callSid].active){
        if(globalState[callSid].playStack.length > 0){
            const text = globalState[callSid].playStack.shift();
            sayResponse(text,callSid);
        }   
        await sleep(1000);
    }
}

const sayResponse = async(text,callSid) => {
  const { connection, streamSid } = globalState[callSid];
  if(typeof text === 'string') {
    const timestamp = new Date().getTime();
    const fileName = `response${timestamp}.mp3`;
    text+= '   ';
    await textToSpeech(text, fileName);
    const bytes = convertAudio(fileName);
    connection.send(
        JSON.stringify({
            streamSid: streamSid,
            event: 'media',
            media: {
            payload: Buffer.from(bytes).toString("base64")
            },
        })
    )
    fs.unlink(fileName, (err) => {
        if (err) {
            console.error(err)
            return
        }
    });
    }
}


const wss = new WebSocketServer({ 
  server,
  path: '/ws'
});
wss.on('connection', async (ws,req) => {
    console.log('WebSocket connected');
    const queryParams = new URLSearchParams(req.url.split('?')[1]);
    let callSid;
    const transcriber = new RealtimeTranscriber({
      apiKey: process.env.ASSEMBLYAI_API_KEY,
      // Twilio media stream sends audio in mulaw format
      encoding: 'pcm_mulaw',
      // Twilio media stream sends audio at 8000 sample rate
      sampleRate: 8000
    })
    const transcriberConnectionPromise = transcriber.connect();
    transcriber.on('transcript.partial', (partialTranscript) => {
      // Don't print anything when there's silence
      if (!partialTranscript.text) return;
      console.clear();
      console.log(partialTranscript.text);
    });
    transcriber.on('transcript.final', (finalTranscript) => {
      console.clear();
      console.log(finalTranscript.text);
      addMessageToThread(callSid,finalTranscript.text);
      //sayResponse(finalTranscript.text,ws);
    });
    transcriber.on('open', () => console.log('Connected to real-time service'));
    transcriber.on('error', console.error);
    transcriber.on('close', () => console.log('Disconnected from real-time service'));
    // Message from Twilio media stream
    ws.on('message', async (message) => {
      const msg = JSON.parse(message);
      switch (msg.event) {
        case 'connected':
          console.info('Twilio media stream connected');
          break;
        case 'start':
          callSid = msg.start.callSid;
          globalState[callSid].active = true;
          globalState[callSid].streamSid = msg.streamSid;
          globalState[callSid].connection = ws;
          console.info('Twilio media stream started');
          break;
        case 'media':
          // Make sure the transcriber is connected before sending audio
          await transcriberConnectionPromise;
          transcriber.sendAudio(Buffer.from(msg.media.payload, 'base64'));
          break;
        case 'stop':
          console.info('Twilio media stream stopped');
          break;
      }
    });
    ws.on('close', async () => {
      console.log('Twilio media stream WebSocket disconnected');
      await transcriber.close();
    })
    await transcriberConnectionPromise;
  });

console.log('Listening on port 9991');
server.listen(9991);