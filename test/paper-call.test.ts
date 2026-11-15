import { describe, expect, it, vi } from 'vitest';
import { LivePaper, MockPaper } from '../src/paper.js';
import { config } from '../src/config.js';

describe('Paper client call compatibility', () => {
  it.each([
    [{ name: 'get_node_info', arguments: { nodeId: 'example' } }],
    ['get_node_info', { nodeId: 'example' }],
  ])('forwards either calling convention without nesting name', async (...args) => {
    const paper = new LivePaper(config({}));
    const callTool = vi.fn().mockResolvedValue({ content: [] });
    vi.spyOn(paper, 'connected').mockResolvedValue({ callTool } as any);
    await (paper.callTool as any)(...args);
    expect(callTool).toHaveBeenCalledWith({
      name: 'get_node_info',
      arguments: { nodeId: 'example' },
    });
  });
  it('defaults missing arguments to an empty object', async () => {
    const paper = new MockPaper();
    await paper.callTool({ name: 'get_canvas' });
    expect(paper.calls[0]).toEqual({ name: 'get_canvas', args: {} });
  });
  it('supports object-form writes in mock mode too', async () => {
    const paper = new MockPaper();
    await paper.callTool({ name: 'set_tokens', arguments: { tokens: { '--x': 'red' } } });
    expect(paper.state.tokens).toEqual({ '--x': 'red' });
  });
  it.each([
    null,
    { name: {} },
    { name: '' },
    { name: 'x', arguments: [] },
    { name: 'x', arguments: null },
  ])('rejects malformed calls before connecting', async (request) => {
    const paper = new LivePaper(config({}));
    const connect = vi.spyOn(paper, 'connected');
    await expect(paper.callTool(request as any)).rejects.toMatchObject({
      code: 'invalid_arguments',
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
