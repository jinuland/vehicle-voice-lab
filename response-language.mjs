export const responseLanguage=value=>value==='en'?'en':'ko';
export function replyLanguageInstruction(value){
  return responseLanguage(value)==='en'
    ? 'Response language: English. This overrides language directions and examples above. Write all reply text, explanations and clarification questions in natural English, even if prior turns or the request are Korean. Keep action names, JSON keys and user-provided place names unchanged. With control actions leave reply empty; the executor supplies the English confirmation.'
    : '응답 언어: 한국어. 이전 대화나 요청이 영어여도 답변과 확인 질문은 자연스러운 한국어로 작성한다. 동작 이름, JSON 키와 사용자가 지정한 장소 이름은 유지한다.';
}
export function speechOptions(value,{voiceId,engine='neural'}={}){
  const language=responseLanguage(value);
  return {voiceId:voiceId||(language==='en'?'Joanna':'Seoyeon'),engine,languageCode:language==='en'?'en-US':'ko-KR'};
}
