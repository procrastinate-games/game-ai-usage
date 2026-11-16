import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutput, writeIfChanged } from '../scripts/aggregate.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const org='procrastinate-games';
const games=[
{repo:org+'/alpha',slug:'alpha',title:'Alpha',_branch:'main',report_count:0},
{repo:org+'/bravo',slug:'bravo',title:'Bravo',_branch:'main',report_count:0},
];
const id='4aa22bd8-e65e-4d15-908c-85835f5d6b61';
const report=(over={})=>({
schema:'game-ai-usage/report@2',report_id:id,repo:org+'/alpha',date:'2026-11-12',
accuracy:'exact',models:[{provider:'anthropic',model:'claude-opus-5-5',input_tokens:10,output_tokens:20,cache_read_tokens:1000,cache_write_tokens:30}],
...over
});
test('public output: only game name and token totals, no session identifiers',()=>{
 const warnings=[];
 const result=buildOutput({config:{org},games,rawReports:[
 {repo:org+'/alpha',path:'.ai-usage/one.json',text:JSON.stringify(report())},
 {repo:org+'/alpha',path:'.ai-usage/copy.json',text:JSON.stringify(report())}
 ],warnings});
 assert.equal(result.schema,'game-ai-usage/usage@2');
 assert.equal(result.games.length,2);
 assert.equal(result.games[0].processed_tokens,1060);
 assert.equal(result.games[0].noncached_output_tokens,30);
 assert.equal(result.games[1].processed_tokens,null);
 assert.deepEqual(Object.keys(result),['schema','games']);
 const output=JSON.stringify(result);
 for(const word of [id,'report_id','task','session','started_at','ended_at','reported_at','model','agent','date','cost_usd','warning','repo','cache_read']) assert.ok(!output.includes(word),word);
 assert.equal(warnings.length,1);
});
test('legacy report not published',()=>{
 const warnings=[];
 const result=buildOutput({config:{org},games,rawReports:[{repo:org+'/alpha',path:'.ai-usage/legacy.json',text:JSON.stringify({...report(),schema:'game-ai-usage/report@1',session_id:'real_session'})}],warnings});
 assert.equal(result.games[0].processed_tokens,null);
 assert.equal(warnings.length,1);
});
test('unknown token counts never become zero',()=>{
 const warnings=[];
 const result=buildOutput({config:{org},games,rawReports:[{repo:org+'/alpha',path:'.ai-usage/unknown.json',text:JSON.stringify(report({accuracy:'unknown',models:[{provider:'other',input_tokens:null,output_tokens:null,cache_read_tokens:null,cache_write_tokens:null}]}))}],warnings});
 assert.equal(result.games[0].processed_tokens,null);
 assert.equal(result.games[0].complete,false);
});
test('writeIfChanged is stable',()=>{
 const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'ai-usage-output-')),'data.json');
 const out={schema:'game-ai-usage/usage@2',games:[]};
 assert.equal(writeIfChanged(file,out),true);
 assert.equal(writeIfChanged(file,out),false);
});
