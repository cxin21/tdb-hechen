/**
 * components/LoginStarfield.tsx — 登录页的星场背景。
 *
 * 只负责「这里也是同一片星场」，不承载任何数据：星尘用 scene/dust 的同一套
 * 尺寸决定位置算法（同尺寸永远同一张底图），散星用黄金角排布、没有 Math.random。
 * 颜色全部取 tokens 变量，画布只是背景层，不参与命中。
 */
import { useEffect, useRef } from 'react';
import { makeDust } from '../starmap/scene/dust';

const GOLDEN = 2.399963229728653;
const STARS = 150;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export default function LoginStarfield({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;

    const paint = (): void => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const dust = makeDust(w, h, 1.6);
      ctx.fillStyle = cssVar('--ink', '#e8f1ff');
      for (let i = 0; i < dust.length; i += 3) {
        ctx.globalAlpha = dust[i + 2];
        ctx.fillRect(dust[i], dust[i + 1], 1, 1);
      }

      const cx = w / 2;
      const cy = h / 2;
      const reach = Math.max(w, h) * 0.62;
      const pal = [cssVar('--star-dim', '#66799b'), cssVar('--dim2', '#5a6b8c'), cssVar('--dim', '#7b8db0')];
      for (let i = 0; i < STARS; i += 1) {
        const r = reach * Math.sqrt((i + 1) / STARS);
        const a = i * GOLDEN;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r * 0.82;
        if (x < 0 || x > w || y < 0 || y > h) continue;
        const size = 0.7 + ((i * 37) % 7) / 10;
        ctx.globalAlpha = 0.20 + ((i * 29) % 5) * 0.10;
        ctx.fillStyle = pal[i % pal.length];
        ctx.beginPath();
        ctx.arc(x, y, size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    paint();
    const onResize = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(paint);
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" data-testid="login-starfield" />;
}
