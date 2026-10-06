import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
if(process.stdin.isTTY){execFileSync('stty',['-echo'],{stdio:'inherit'});process.stdin.setRawMode(true);}
process.stdout.write('Ready for upload configuration on stdin (input hidden).\n');
let input='';
for await(const chunk of process.stdin){input+=chunk;if(input.includes('\n'))break;}
try {const configuration=JSON.parse(input);const content=await readFile(process.argv[2]);const response=await fetch(configuration.url,{method:'PUT',headers:configuration.headers||{'Content-Type':'text/plain'},body:content});if(!response.ok){const body=await response.text();const code=body.match(/<Code>([^<]+)<\/Code>/)?.[1]||'';const message=body.match(/<Message>([^<]+)<\/Message>/)?.[1]||'';throw new Error(`Upload returned HTTP ${response.status} ${code} ${message.slice(0,120)}`);}process.stdout.write('Source uploaded successfully.\n');}
catch(error){process.stdout.write(`Source upload failed: ${error.name} ${error.cause?.code||''} ${String(error.message).startsWith('Upload returned HTTP')?error.message:''}\n`);process.exitCode=1;}
finally{if(process.stdin.isTTY){process.stdin.setRawMode(false);execFileSync('stty',['echo'],{stdio:'inherit'});}process.exit(process.exitCode||0);}
