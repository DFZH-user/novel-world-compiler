import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('retained integrated.10 opens a restored project in isolated user data', async()=>{
  const executablePath=process.env.NOVEL_ROLLBACK_OLD_EXE;
  const restored=process.env.NOVEL_ROLLBACK_PROJECT;
  test.skip(!executablePath || !restored,'Requires retained old executable and audit restoration');
  if(!restored!.includes('.codex-redesign-audit')) throw new Error('Only restored audit copies');
  const output=path.join(path.dirname(path.dirname(restored!)),`old-app-check-${Date.now()}`);
  await fs.mkdir(output,{recursive:true});
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),NOVEL_COMPILER_USER_DATA:output};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NOVEL_COMPILER_SILLYTAVERN_ROOT;
  const app=await electron.launch({executablePath,args:[],env});
  try {
    const page=await app.firstWindow();
    const version=await app.evaluate(({app})=>app.getVersion());
    expect(version).toBe('0.3.0-integrated.10');
    await app.evaluate(({dialog},root)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]});},restored!);
    const project=await page.evaluate(()=>window.novelCompiler.openProject());
    expect(project?.id).toBe('a3aa8241-3930-4340-b216-31481a575003');
    expect(project?.rootPath).toBe(restored);
    await fs.writeFile(path.join(output,'result.json'),JSON.stringify({version,project},null,2));
    console.log('Retained old-version rollback:',output);
  } finally {await app.close();}
});
