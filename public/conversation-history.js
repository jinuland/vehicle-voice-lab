export function followConversation(list,pinned){if(pinned)list.scrollTop=list.scrollHeight;}
export function transcriptMessages(snapshot){
 if(!snapshot||!Array.isArray(snapshot.turns))throw Error('차량 대화 기록 JSON 파일을 선택해 주세요.');
 return snapshot.turns.flatMap(turn=>[
  typeof turn.input==='string'&&turn.input.trim()?{type:'user',text:turn.input}:null,
  typeof turn.reply==='string'&&turn.reply.trim()?{type:'assistant',text:turn.reply}:null,
 ].filter(Boolean));
}
