import { describe, it, expect } from "vitest";
import { stripDshAcpTags } from "../acp-tag.js";

const NL = String.fromCharCode(10);

describe('stripDshAcpTags (#89)', () => {
  it('R1: 头部标签+真实文本 → 剥标签留文本', () => {
    expect(stripDshAcpTags('<acp tokens="22" type="text">m00458</acp> 不要影子规则，直接完整实现')).toBe('不要影子规则，直接完整实现');
  });

  it('R2: 头+中+尾多枚标签全剥 + 空行折叠', () => {
    const input = '<acp tokens="1">m1</acp>' + NL + NL + '正文A' + NL + '<acp tokens="2">m2</acp>' + NL + NL + NL + NL + '正文B' + NL + '<acp tokens="3">m3</acp>';
    expect(stripDshAcpTags(input).split(NL)).toEqual(['正文A', '', '正文B']);
  });

  it('R3: 纯标签行 → 剥后为空串', () => {
    expect(stripDshAcpTags('<acp tokens="1" type="text">m1</acp>')).toBe('');
  });

  it('R4: 畸形闭合 <//acp> 同样剥净（镜像 classifier P1 容差）', () => {
    expect(stripDshAcpTags('<acp tokens="9">m9<//acp>正文')).toBe('正文');
  });

  it('R5: 非 acp 协议块不受影响', () => {
    const input = '<system-reminder>keep me</system-reminder>' + NL + '正文';
    expect(stripDshAcpTags(input)).toBe(input);
  });

  it('未闭合 acp 标签不动（无法安全定界）', () => {
    const input = '<acp tokens="1">m1 现在几点？';
    expect(stripDshAcpTags(input)).toBe(input);
  });

  it('空串原样；无标签文本仅修剪首尾空白', () => {
    expect(stripDshAcpTags('')).toBe('');
    expect(stripDshAcpTags('  hello  ')).toBe('hello');
  });
});
