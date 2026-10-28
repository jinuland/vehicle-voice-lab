// Session-private diagnostics; exported only through that visitor's session.
export function appendSonicToolTrace(record,data){
 record.toolTrace??=[];
 record.toolTrace.push({at:new Date().toISOString(),toolName:data.toolName,toolUseId:data.toolUseId,inputSnapshot:record.input,arguments:structuredClone(data.arguments??null),rawArguments:data.rawArguments,errorStage:data.errorStage,ok:data.ok,error:data.error,actions:structuredClone(data.actions??[]),results:structuredClone(data.results??[]),operation:data.operation,effect:structuredClone(data.effect??null)});
 if(data.ok===false){record.validationError=data.error;record.failedToolCalls=(record.failedToolCalls||0)+1;}
}
export function guardSonicRadio(input,actions){
 const radio=/라디오|\bradio\b/i.test(input||''),music=/음악|플레이리스트|\bmusic\b|\bplaylist\b/i.test(input||'');
 if(radio&&!music&&actions.some(a=>a.type==='media'&&a.value==='play'))throw Error('실제 라디오 요청을 모의 음악 재생으로 처리할 수 없습니다. 다른 차량 설정을 먼저 처리한 뒤 라디오 도구를 별도로 호출해 주세요.');
}
