// The deployed Seoul Polly API was checked for these Korean voice/engine pairs.
export const gameVoices=Object.freeze([
 {id:'seoyeon',name:'서연 · 여성 · 기본',voiceId:'Seoyeon',engine:'neural',description:'지금까지 사용하던 기본 목소리예요.'},
 {id:'jihye',name:'지혜 · 여성',voiceId:'Jihye',engine:'neural',description:'서연과 다른 여성 목소리예요.'},
 {id:'hyunduk',name:'현덕 · 남성 · 생성형',voiceId:'Hyunduk',engine:'generative',description:'남성 목소리예요. 생성형 합성은 준비 시간이 조금 더 걸릴 수 있어요.'},
 {id:'seoyeon-generative',name:'서연 · 여성 · 생성형',voiceId:'Seoyeon',engine:'generative',description:'같은 서연 목소리를 생성형 엔진으로 합성해요. 기본 버전과 비교해 보세요.'}
].map(Object.freeze));
export const defaultGameVoice='seoyeon';
export const gameVoicePreview='들려? 나 지우야. 오늘은 꼭 퇴근하자.';
export function findGameVoice(id=defaultGameVoice){
 const voice=gameVoices.find(v=>v.id===id);
 if(!voice)throw Error('목록에 있는 목소리를 골라주세요.');
 return voice;
}
