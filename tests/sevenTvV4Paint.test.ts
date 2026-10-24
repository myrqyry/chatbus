import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSevenTvPaintV4Cache, fetchSevenTvPaintV4Detailed } from '../src/index';

const painted = {
  data: { users: { userByConnection: {
    style: { activePaint: { id: 'paint-1' } },
    inventory: { paints: [{ to: { paint: { id: 'paint-1', name: 'Layers', data: {
      layers: [
        { id: 'base', opacity: 1, ty: { __typename: 'PaintLayerTypeSingleColor',
          color: { hex: '#123456FF' } } },
        { id: 'middle', opacity: 0.4, ty: { __typename: 'PaintLayerTypeLinearGradient',
          angle: 45, repeating: true, stops: [
            { at: 0, color: { hex: '#FF000080' } }, { at: 1.01, color: { hex: '#00FF00FF' } },
          ] } },
        { id: 'top', opacity: 0.75, ty: { __typename: 'PaintLayerTypeImage',
          images: [{ url: 'javascript:alert(1)', scale: 1, frameCount: 1 },
            { url: 'https://cdn.7tv.app/paint/valid/1x.webp', scale: 2, frameCount: 1 }] } },
        { id: 'radial', opacity: 1, ty: { __typename: 'PaintLayerTypeRadialGradient',
          shape: 'CIRCLE', repeating: false, stops: [
            { at: 0, color: { hex: '#01020304' } }, { at: 1, color: { hex: '#AABBCCDD' } },
          ] } },
      ],
      shadows: [{ offsetX: 2, offsetY: -1, blur: 3, color: { hex: '#00000080' } }],
    } } } }] },
  } } },
};
beforeEach(() => {
  clearSevenTvPaintV4Cache();
  vi.restoreAllMocks();
});
describe('7TV v4 layered paint from shared Chatbus substrate', () => {
  it('queries current active paint and preserves ordered, individually opaque, validated layers', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: { platformId: string } };
      expect(request.variables.platformId).toBe('1234');
      expect(request.query).toContain('activePaint');
      expect(request.query).toContain('opacity');
      return new Response(JSON.stringify(painted), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await fetchSevenTvPaintV4Detailed('1234');
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      id: 'paint-1', provider: '7tv', name: 'Layers',
      layers: [
        { kind: 'solid', opacity: 1, color: 0xff123456 },
        { kind: 'linear', opacity: 0.4, angle: 45, repeating: true,
          stops: [{ at: 0, color: 0x80ff0000 }, { at: 1.01, color: 0xff00ff00 }] },
        { kind: 'image', opacity: 0.75, url: 'https://cdn.7tv.app/paint/valid/1x.webp' },
        { kind: 'radial', opacity: 1, shape: 'circle', repeating: false,
          stops: [{ at: 0, color: 0x04010203 }, { at: 1, color: 0xddaabbcc }] },
      ],
      shadows: [{ xOffset: 2, yOffset: -1, radius: 3, color: 0x80000000 }],
    });
    await fetchSevenTvPaintV4Detailed('1234');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not negative-cache an upstream failure but caches a genuine no-paint response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ errors: [{ message: 'temporary outage' }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { users: { userByConnection: {
        style: { activePaint: null }, inventory: { paints: [] },
      } } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchSevenTvPaintV4Detailed('one')).toMatchObject({ ok: false, value: null });
    expect(await fetchSevenTvPaintV4Detailed('one')).toEqual({ ok: true, value: null });
    expect(await fetchSevenTvPaintV4Detailed('one')).toEqual({ ok: true, value: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent user lookups and invalidates the right user cache entry', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(painted), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const results = await Promise.all(Array.from({ length: 3 }, () => fetchSevenTvPaintV4Detailed('abc')));
    expect(results.every(result => result.ok && result.value?.id === 'paint-1')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearSevenTvPaintV4Cache('abc');
    await fetchSevenTvPaintV4Detailed('abc');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});