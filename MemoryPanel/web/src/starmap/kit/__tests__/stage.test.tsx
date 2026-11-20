import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Stage } from '../Stage';
import { Surface } from '../Surface';

const html = (node: React.ReactElement) => renderToStaticMarkup(node);

describe('Stage：星场是背景层，UI 浮在上面', () => {
  it('field 先于 UI 渲染，且各自落在 field / ui 两个层里', () => {
    const out = html(
      <Stage field={<span id="field-x">canvas</span>} top={<i id="top-x" />} left={<b id="left-x" />} right={<u id="right-x" />} />,
    );
    const fieldAt = out.indexOf('stk-stage-field');
    const uiAt = out.indexOf('stk-stage-ui');
    expect(fieldAt).toBeGreaterThan(-1);
    expect(uiAt).toBeGreaterThan(fieldAt);
    expect(out.indexOf('id="field-x"')).toBeGreaterThan(fieldAt);
    expect(out.indexOf('id="field-x"')).toBeLessThan(uiAt);
    expect(out).toContain('stk-stage-top');
    expect(out).toContain('stk-stage-left');
    expect(out).toContain('stk-stage-right');
  });

  it('中栏留白给星场：没传 center 也渲染 stk-stage-mid，且内部为空', () => {
    const out = html(<Stage field={<div />} />);
    expect(out).toContain('stk-stage-mid');
    expect(out).not.toContain('stk-stage-top');
    expect(out).not.toContain('stk-stage-left');
  });

  it('面板仍是实底 Surface（不因浮空改成半透明壳）：DOM 里没有 backdrop/玻璃类名', () => {
    const out = html(
      <Stage
        field={<div />}
        left={
          <Surface title="筛选" dense>
            内容
          </Surface>
        }
      />,
    );
    expect(out).toContain('stk-surface');
    expect(out).not.toContain('glass');
    expect(out).not.toContain('blur');
  });
});
