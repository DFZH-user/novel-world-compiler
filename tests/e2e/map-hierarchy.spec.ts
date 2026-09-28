import { expect, test, _electron as electron } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

test('map follows confirmed region, settlement and landmark hierarchy', async () => {
  test.setTimeout(60000);
  const sample=process.env.NOVEL_REDESIGN_SAMPLE;
  test.skip(!sample, 'Requires offline audit fixture');
  if(!sample!.includes('.codex-redesign-audit')) throw new Error('Use protected audit data');
  const audit=path.dirname(sample!);
  const book=JSON.parse(await fs.readFile(path.join(audit,'map-hierarchy-fixture.json'),'utf8'));
  const output=path.join(audit,`map-hierarchy-${Date.now()}`);
  await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'project-library.json'),JSON.stringify([book]));
  const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string]=>typeof entry[1]==='string')),NOVEL_COMPILER_USER_DATA:output,NODE_ENV:'test'};
  delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.NOVEL_PACKAGED_EXECUTABLE;
  const app=await electron.launch({executablePath,args:executablePath?[]:[path.resolve('.')],env});
  try {
    const page=await app.firstWindow();
    await page.getByRole('button',{name:'打开这本书'}).click();
    await page.getByRole('button',{name:'进入编译工作台'}).click();
    await page.getByRole('button',{name:'叙事地图'}).click();
    const map=page.getByRole('region',{name:'世界地点总览'});
    await expect(map.getByRole('button',{name:'查看地点 东境',exact:true})).toBeVisible();
    await expect(map.getByRole('button',{name:'查看地点 城门',exact:true})).toHaveCount(0);
    const firstPosition=await map.getByRole('button',{name:'查看地点 东境',exact:true}).evaluate(el=>el.parentElement?.getAttribute('transform'));
    await map.getByRole('button',{name:'展开区域 东境',exact:true}).click();
    await expect(map.getByRole('button',{name:'查看地点 青石镇',exact:true})).toBeVisible();
    await map.getByRole('button',{name:'展开区域 青石镇',exact:true}).click();
    await map.getByRole('button',{name:'查看地点 城门',exact:true}).click();
    await expect(map.locator('.atlas-detail')).toContainText('所属区域：青石镇');
    await expect(map.locator('.atlas-detail blockquote')).toHaveText('青石镇属于东境，城门位于青石镇内。');
    await page.screenshot({path:path.join(output,'hierarchy.png'),fullPage:true});
    await map.getByRole('button',{name:'返回上层',exact:true}).click();
    await expect(map.locator('.atlas-toolbar h3')).toHaveText('东境');
    await map.getByRole('button',{name:'世界概览',exact:true}).click();
    const restoredPosition=await map.getByRole('button',{name:'查看地点 东境',exact:true}).evaluate(el=>el.parentElement?.getAttribute('transform'));
    expect(restoredPosition).toBe(firstPosition);
    await map.getByLabel('图册搜索地点').fill('城门');
    await expect(map.getByRole('button',{name:'查看地点 城门',exact:true})).toBeVisible();
    console.log('Map hierarchy acceptance:',output);
  } finally {await app.close();}
});
