// Voice output is separate from Sonic's native speech stream. The preview
// adapter provides a stable seam; a future clone adapter must implement the
// documented GA API once its contract and access are available.
export function createVoiceOutput({synthesize}){
  if(typeof synthesize!=='function')throw Error('A synthesis implementation is required');
  return {
    async render({text,language='ko',mode='polly'},signal){
      if(mode==='clone')throw Object.assign(new Error('Polly voice cloning is not configured or verified'),{code:'CLONE_NOT_AVAILABLE'});
      if(mode!=='polly')throw Error('Unsupported output mode');
      if(typeof text!=='string'||!text.trim()||text.length>300)throw Error('Preview text must be 1–300 characters');
      const lang=language==='en'?'en':'ko';
      const output=await synthesize(text.trim(),'polly',signal,{language:lang,engine:'neural'});
      return {...output,provider:'polly',mode:'polly',language:lang};
    },
  };
}
