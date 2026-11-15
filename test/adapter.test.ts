// test/adapter.test.ts
import { describe, it, expect } from 'vitest';
import adapter from '../examples/live-adapter.mjs';

describe('Live Paper adapter', () => {
  describe('classify', () => {
    it('classifies write_html as write', () => {
      expect(adapter.classify('write_html')).toBe('write');
    });

    it('classifies unknown tools as write (fail-closed)', () => {
      expect(adapter.classify('unknown_tool')).toBe('write');
    });

    it('classifies read tools as read', () => {
      expect(adapter.classify('get_jsx')).toBe('read');
      expect(adapter.classify('get_computed_styles')).toBe('read');
      expect(adapter.classify('get_basic_info')).toBe('read');
    });

    it('classifies finish_working_on_nodes as passthrough', () => {
      expect(adapter.classify('finish_working_on_nodes')).toBe('passthrough');
    });
  });

  describe('normalize', () => {
    const baseState = {
      canvas: {
        'node-1': [
          { tag: 'div', attrs: {}, text: '', children: [] },
        ],
      },
      tokens: {},
    };

    it('returns a core-compatible structural mutation for an empty page insertion', () => {
      const args={fileId:'file-1',targetNodeId:'root-1',mode:'insert-children',html:'<h1>Hello</h1>'};
      expect(adapter.normalize('write_html',args,{canvas:{'file-1:root-1':[]},tokens:{}})).toEqual([{kind:'html',targetNodeId:'file-1:root-1',html:args.html}]);
    });
    it('rejects an insertion whose complete resulting subtree cannot be predicted',()=>{
      expect(()=>adapter.normalize('write_html',{fileId:'file-1',targetNodeId:'root-1',mode:'insert-children',html:'<p>Next</p>'},{canvas:{'file-1:root-1':[{tag:'h1'}]},tokens:{}})).toThrow('UNSUPPORTED_MUTATION_PREDICTION');
    });

    it('throws when a write_html payload contains <style>', () => {
      expect(() =>
        adapter.normalize(
          'write_html',
          { targetId: 'node-1', html: '<div><style>a{}</style></div>' },
          baseState,
        ),
      ).toThrow(/<style>/i);
    });

    it('throws UNSUPPORTED_MUTATION_PREDICTION for unpredicted tools', () => {
      expect(() =>
        adapter.normalize('create_artboard', {}, baseState),
      ).toThrow('UNSUPPORTED_MUTATION_PREDICTION');

      expect(() =>
        adapter.normalize('delete_nodes', {}, baseState),
      ).toThrow('UNSUPPORTED_MUTATION_PREDICTION');

      expect(() =>
        adapter.normalize('set_text_content', {}, baseState),
      ).toThrow('UNSUPPORTED_MUTATION_PREDICTION');
    });

    it('returns a token mutation when update_styles targets a CSS variable', () => {
      const result = adapter.normalize(
        'update_styles',
        { targetId: 'root', styles: { '--accent': '#ff0000' } },
        baseState,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('token');
      const tokenMutation = result[0] as {
        type: string;
        name: string;
        value: string;
      };
      expect(tokenMutation.name).toBe('--accent');
      expect(tokenMutation.value).toBe('#ff0000');
    });

    it('returns a node mutation when update_styles targets a regular property', () => {
      const result = adapter.normalize(
        'update_styles',
        { targetId: 'node-1', styles: { color: 'red' } },
        baseState,
      );
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('node');
      const nodeMutation = result[0] as {
        type: string;
        nodes: Array<{ attrs: { style: string } }>;
      };
      expect(nodeMutation.nodes[0].attrs.style).toContain('color: red');
    });
  });

  describe('capture', () => {
    it('throws when get_jsx returns empty (refuses to fabricate)', async () => {
      const fakePaper = {
        callTool: async ({ name }: { name: string }) => {
          if (name === 'get_basic_info') {
            return {
              content: [{ type: 'text', text: JSON.stringify({file:{id:'file-1'},pageId:'page-1',rootNodeId:'root-1',pages:[{id:'page-1',type:'page'}],tokens:{items:[]}}) }],
            };
          }
          if (name === 'get_children') return {content:[{type:'text',text:JSON.stringify({children:[{id:'node-1'}],count:1})}]};
          if (name === 'get_jsx') {
            return { content: [{ type: 'text', text: '   ' }] };
          }
          return { content: [{ type: 'text', text: '{}' }] };
        },
      };

      await expect(adapter.capture(fakePaper)).rejects.toThrow(/empty|fabricate/i);
    });

    it('throws when get_jsx fails via isError', async () => {
      const fakePaper = {
        callTool: async ({ name }: { name: string }) => {
          if (name === 'get_basic_info') {
            return {
              content: [{ type: 'text', text: JSON.stringify({file:{id:'file-1'},pageId:'page-1',rootNodeId:'root-1',pages:[{id:'page-1',type:'page'}],tokens:{items:[]}}) }],
            };
          }
          if (name === 'get_children') return {content:[{type:'text',text:JSON.stringify({children:[{id:'node-1'}],count:1})}]};
          if (name === 'get_jsx') {
            return { isError: true, content: [] };
          }
          return { content: [{ type: 'text', text: '{}' }] };
        },
      };

      await expect(adapter.capture(fakePaper)).rejects.toThrow(/reported an error/i);
    });
  });
});