import {createInterface} from 'node:readline';
import {WritingMcp} from '../packages/infra/writing-mcp.ts';
import {WritingClient} from '../packages/infra/writing-client.ts';

const server=new WritingMcp(new WritingClient(process.env.DREAMER_URL??'http://127.0.0.1:4327',process.env.DREAMER_WRITING_CLIENT_ID??'external-default'));
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
for await(const line of lines){
 if(!line.trim())continue;
 let input:unknown;
 try{if(Buffer.byteLength(line)>2_000_000)throw new Error('oversize');input=JSON.parse(line);}
 catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
 const response=await server.handle(input);
 if(response!==undefined)process.stdout.write(JSON.stringify(response)+'\n');
}
