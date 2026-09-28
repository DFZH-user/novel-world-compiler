
import { createGenerationParameters, oai_settings, getChatCompletionModel } from './openai.js';
import { getRequestHeaders } from '../script.js';
import { parseJson } from './novel-story-core.js';

// Use a detached copy: no temporary global presets, no compiler credentials, no hidden chat messages.
export async function requestStoryJson({ system, sources, settings, kind, signal }) {
  settings={...settings};
  const prefix = kind === 'check' ? 'check' : 'settle';
  const model = settings[prefix+'Model'].trim() || getChatCompletionModel(oai_settings);
  const configuration = structuredClone(oai_settings);
  Object.assign(configuration,{ stream_openai:false, openai_max_tokens:settings[prefix+'Tokens'], temp_openai:0.1, freq_pen_openai:0, pres_pen_openai:0, top_p_openai:1, show_thoughts:false, enable_web_search:false, request_images:false, reasoning_effort:'min', bias_preset_selected:'', seed:-1 });
  const messages = [{role:'system',content:system},{role:'user',content:JSON.stringify(sources)}];
  const {generate_data} = await createGenerationParameters(configuration,model,'quiet',messages);
  Object.assign(generate_data,{stream:false,max_tokens:settings[prefix+'Tokens'],stop:[],n:1,include_reasoning:false});
  delete generate_data.tools; delete generate_data.logit_bias;
  if (/^deepseek-(flash|v4)/i.test(model)) generate_data.reasoning_effort='min';
  let last;
  for(let attempt=0;attempt<settings[prefix+'Attempts'];attempt++) {
    signal?.throwIfAborted();
    const controller=new AbortController();
    const abort=()=>controller.abort(signal.reason);
    signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(new Error('辅助分析超时，请调大等待时间或减少分析材料')),settings[prefix+'Timeout']*1000);
    try {
      const response=await fetch('/api/backends/chat-completions/generate',{method:'POST',headers:getRequestHeaders(),body:JSON.stringify(generate_data),signal:controller.signal});
      if(!response.ok) throw new Error('辅助模型请求失败（HTTP '+response.status+'），请检查酒馆连接、模型和预算设置');
      const data=await response.json();
      if(data.error) throw new Error('辅助模型返回错误，请检查所选模型和连接参数');
      const finish=data.choices?.[0]?.finish_reason ?? data.stop_reason ?? data.candidates?.[0]?.finishReason;
      if(['length','max_tokens','MAX_TOKENS'].includes(finish)) throw new Error('辅助结果达到输出上限，请提高对应输出预算后重试');
      if(['content_filter','SAFETY'].includes(finish)) throw new Error('辅助结果未返回可用内容');
      const content=data.choices?.[0]?.message?.content ?? (Array.isArray(data.content)?data.content.filter(c=>c.type==='text').map(c=>c.text).join(''):null) ?? data.candidates?.[0]?.content?.parts?.filter(p=>p.text&&!p.thought).map(p=>p.text).join('');
      return parseJson(content);
    } catch(error) {
      if(signal?.aborted) throw error;
      last=controller.signal.aborted ? controller.signal.reason : error;
      if(attempt+1<settings[prefix+'Attempts']) await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
  }
  throw last;
}
