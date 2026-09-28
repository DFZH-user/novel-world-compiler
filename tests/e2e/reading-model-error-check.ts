import { expect, type ElectronApplication } from '@playwright/test';

export async function checkReadingModelError(app: ElectronApplication) {
  const result = await app.evaluate(async ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBrowserViews()[0].webContents.executeJavaScript(`(async () => {
    const native=await import('/script.js');
    const context=(await import('/scripts/st-context.js')).getContext();
    const {oai_settings}=await import('/scripts/openai.js');
    const previousStream=oai_settings.stream_openai;
    const previousStatus=context.onlineStatus;
    const before=context.chat.map(x=>x.mes);
    const originalFetch=window.fetch;
    let requests=0,fail=true;
    const errors=[];
    const originalToast=toastr.error;
    toastr.error=(...args)=>{errors.push(String(args[0]));return originalToast.apply(toastr,args);};
    window.fetch=async function(resource,options) {
      if(String(resource).includes('/api/backends/chat-completions/generate')) {
        requests++;
        return fail ? new Response(JSON.stringify({error:{message:'Unsupported parameter: temperature (offline test)'}}),{status:400,headers:{'content-type':'application/json'}})
          : new Response(JSON.stringify({choices:[{message:{role:'assistant',content:'青石镇验收回复：请求已恢复。'},finish_reason:'stop'}]}),{status:200,headers:{'content-type':'application/json'}});
      }
      if (/^https?:/.test(String(resource)) && !String(resource).startsWith(location.origin)) throw new Error('External request forbidden during acceptance');
      return originalFetch.call(this,resource,options);
    };
    oai_settings.stream_openai=false; native.setOnlineStatus('offline-test-connected');
    document.getElementById('send_textarea').value='';
    let afterFailure,afterRetry;
    try {
      try { await native.Generate('normal'); } catch { /* Expected API incompatibility */ }
      afterFailure=context.chat.map(x=>x.mes);
      fail=false;
      await native.Generate('normal');
      afterRetry=context.chat.map(x=>x.mes);
    } finally {
      window.fetch=originalFetch;toastr.error=originalToast;oai_settings.stream_openai=previousStream;native.setOnlineStatus(previousStatus);
    }
    return {requests,errors,before,afterFailure,afterRetry};
  })()`));
  expect(result.requests).toBe(2);
  expect(result.errors.join('\n')).toContain('Unsupported parameter: temperature');
  expect(result.afterFailure).toEqual(result.before);
  expect(result.afterRetry.slice(0, result.before.length)).toEqual(result.before);
  expect(result.afterRetry.at(-1)).toBe('青石镇验收回复：请求已恢复。');
}
