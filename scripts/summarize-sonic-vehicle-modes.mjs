// Report both the historical exact action score and a separate seatHeat-zone
// equivalence score. The simulator has one seatHeat value and ignores zone.
import {readFile} from 'node:fs/promises';
function canonical(actions){return actions.flatMap(a=>a.type==='temperature'&&a.zone==='both'?[{...a,zone:'driver'},{...a,zone:'passenger'}]:[a]).map(a=>{const copy={...a};if(copy.type==='seatHeat'&&copy.zone==='both')delete copy.zone;return JSON.stringify(Object.fromEntries(Object.entries(copy).sort()));}).sort();}
for(const path of process.argv.slice(2)){
 const report=JSON.parse(await readFile(path,'utf8'));let adjusted=0;const rescued=[];
 for(const row of report.rows){
  const actionCorrect=JSON.stringify(canonical(row.actualActions||[]))===JSON.stringify(canonical(row.expectedActions||[]));
  const pass=!row.error&&row.preludeCorrect&&actionCorrect&&row.stateCorrect&&row.answerCorrect&&row.intentCorrect&&row.denialCorrect&&row.audioValid&&!row.toolErrors?.length;
  if(pass)adjusted++;if(pass&&!row.passed)rescued.push(row.id);
 }
 console.log(JSON.stringify({file:path,mode:report.mode,strict:report.summary.passed,seatHeatEquivalent:adjusted,rescued}));
}
