// Deterministic rules only. This module has no model, HTTP or credential dependencies.
import { tokenPeople } from './local-text-rank';
const stopNames = new Set('自己 他们 我们 你们 大家 有人 没人 什么 这个 那个 于是 然后 不过 因为 所以 但是 突然 终于 现在 当时 今天 明天 昨天 母亲 父亲 先生 女士 老师 主人 少年 少女 男人 女人 男子 女子 对方 声音 众人 所有人 有的人 一个人 这时候 那时候 听到 看到 只好 不禁 连忙 微笑 冷笑 无奈 低声 大声 缓缓 轻轻 点头 摇头 笑着 哭着 说完 说话 第一次 一开始 没想到'.split(' '));
const surname = /^[赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗方俞任袁柳史唐费薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元顾孟平黄和穆萧尹姚邵汪祁毛禹狄米贝明臧计伏成戴宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄江童颜郭梅盛林刁钟徐邱骆高夏蔡田胡凌霍虞万支柯管卢莫房裘缪干解应宗丁宣邓郁单杭洪包诸左石崔吉龚程邢裴陆荣翁荀羊甄曲家封芮储靳段富巫乌焦巴牧山谷车侯全班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶黎乔苍双闻莘党翟谭贡劳姬申冉雍桑桂濮牛寿通边燕冀尚农温庄晏柴瞿阎慕连茹习艾鱼容向古戈廖庾终文司徒诸葛欧阳上官]/u;

export function validName(name: string): boolean {
  return /^[\p{Script=Han}]{2,6}(?:[·•][\p{Script=Han}]{1,12}){0,3}$/u.test(name)
    && !stopNames.has(name) && !/(?:时候|这样|那样|说道|回答|问道|一个|两个|第[一二三四五六七八九十]|的|了|不是|可以|应该|知道)/u.test(name);
}

export function discoverNames(text: string): string[] {
  const found = new Set<string>();
  for (const name of tokenPeople(text)) if (validName(name)) found.add(name);
  // Boundaries prevent taking arbitrary suffixes from a long narrative clause.
  const speaker = /(?:^|[\s，。！？；：“”「」『』])([\p{Script=Han}]{2,6}(?:[·•][\p{Script=Han}]{1,12}){0,3})(?:则|却|便|又|也)?(?:说道|问道|答道|喊道|回答|开口|(?:说|问|答|道)[：，。！？“「『])/gu;
  for (const match of text.matchAll(speaker)) if (validName(match[1])) found.add(match[1]);
  const action = /(?:^|[\s，。！？；：“”「」『』])([\p{Script=Han}]{2,3})(?:走进|走出|转身|点头|摇头|抬头|皱眉|看着|望着|站在|来到|低声说|笑着说)/gu;
  for (const match of text.matchAll(action)) if (surname.test(match[1]) && validName(match[1])) found.add(match[1]);
  for (const match of text.matchAll(/[\p{Script=Han}]{2,6}[·•][\p{Script=Han}]{2,10}(?:[·•][\p{Script=Han}]{2,10})?/gu)) if (validName(match[0])) found.add(match[0]);
  return [...found];
}

export function discoverWorldTerms(text: string): Array<{ name: string; kind: 'place' | 'term' }> {
  const found = new Map<string, 'place' | 'term'>();
  for (const m of text.matchAll(/(?:来到|前往|抵达|位于|住在|进入|离开|返回|到达|在)([\p{Script=Han}]{1,7}(?:城|村|镇|山|谷|岛|大陆|王国|帝国|学院|森林|宫殿))(?:[，。！？；、的里内中]|$)/gu)) {
    if (!/[的这那一两]|时候|自己/u.test(m[1])) found.set(m[1], 'place');
  }
  for (const m of text.matchAll(/[“「『]([\p{Script=Han}]{2,12})[”」』](?:这种|这个|是|指|叫|称)/gu)) found.set(m[1], 'term');
  return [...found].map(([name, kind]) => ({ name, kind }));
}

export function excerptScore(text: string): number {
  return 1 + (/(?:名叫|本名|岁|出生|身高|头发|眼睛|擅长|武器|能力|身份|父亲|母亲|兄弟|姐妹|师父|徒弟|王国|魔法|规则|称为|叫做)/u.test(text) ? 3 : 0);
}

// Aho–Corasick indexes all selected names together; each paragraph is scanned once.
export class LocalNameMatcher {
  private nodes: Array<{ next: Map<string, number>; fail: number; words: string[] }> = [{ next: new Map(), fail: 0, words: [] }];
  constructor(words: string[]) {
    for (const word of new Set(words)) {
      let state = 0;
      for (const char of word) {
        let next = this.nodes[state].next.get(char);
        if (next === undefined) { next = this.nodes.length; this.nodes[state].next.set(char, next); this.nodes.push({ next: new Map(), fail: 0, words: [] }); }
        state = next;
      }
      this.nodes[state].words.push(word);
    }
    const queue = [...this.nodes[0].next.values()];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      for (const [char, child] of this.nodes[parent].next) {
        queue.push(child);
        let fail = this.nodes[parent].fail;
        while (fail && !this.nodes[fail].next.has(char)) fail = this.nodes[fail].fail;
        this.nodes[child].fail = this.nodes[fail].next.get(char) ?? 0;
        this.nodes[child].words.push(...this.nodes[this.nodes[child].fail].words);
      }
    }
  }
  find(text: string): Array<{ name: string; start: number; end: number }> {
    const result: Array<{ name: string; start: number; end: number }> = [];
    let state = 0, offset = 0;
    for (const char of text) {
      while (state && !this.nodes[state].next.has(char)) state = this.nodes[state].fail;
      state = this.nodes[state].next.get(char) ?? 0;
      offset += char.length;
      for (const name of this.nodes[state].words) result.push({ name, start: offset - name.length, end: offset });
    }
    return result;
  }
}

export function evidenceRange(text: string, start: number, end: number): { start: number; end: number } {
  let left = start, right = end;
  while (left > 0 && start - left < 100 && !/[。！？\n]/u.test(text[left - 1])) left--;
  while (right < text.length && right - end < 160 && !/[。！？\n]/u.test(text[right])) right++;
  if (right < text.length && /[。！？]/u.test(text[right])) right++;
  return { start: left, end: right };
}
