"""Patch only Sonic hooks while preserving deployment-specific backend modules."""
import pathlib,sys
p=pathlib.Path(sys.argv[1]);s=p.read_text()
if "from './sonic-tool-trace.mjs'" not in s:
 anchor="    const proposedPlan=parsePlan(JSON.stringify({intent:args.actions?.length?'control':'question',actions:args.actions,reply:''}));"
 marker="    s.updated=Date.now();\n    if(event==='text'){"
 if s.count(anchor)!=1 or s.count(marker)!=1:raise SystemExit('Unexpected Sonic backend; no changes made')
 s="import {appendSonicToolTrace,guardSonicRadio} from './sonic-tool-trace.mjs';\n"+s
 s=s.replace(anchor,"    guardSonicRadio(record?.input,args.actions||[]);\n"+anchor)
 s=s.replace(marker,"    s.updated=Date.now();\n    if(event==='tool'){if(!record||record.completed)newRecord();appendSonicToolTrace(record,data);}\n    if(event==='text'){")
 p.write_text(s)
s=p.read_text()
old='return{ok:true,state:s.state,reply:result.reply,results:result.results,actions:plan.actions};'
new='return{ok:!gate.reason,error:gate.reason?localizeVehicleText(gate.reason,language):undefined,validationError:gate.reason,state:s.state,reply:result.reply,results:result.results,actions:plan.actions};'
if old in s:p.write_text(s.replace(old,new))
s=p.read_text()
anchor="if(event==='usage'&&record)record.usage=data;"
if 'record.responseError=' not in s:
 p.write_text(s.replace(anchor,anchor+"\n    if(event==='error'&&record)record.responseError={...data,stage:data.code==='invalid-spoken-tool-call'?'spoken-response':'stream'};"))
print('Sonic compound hooks ready')
