// examples/live-adapter.mjs
import { parse } from 'node-html-parser';

const READ_TOOLS = new Set([
  'get_basic_info', 'get_selection', 'get_node_info', 'get_children',
  'get_tree_summary', 'get_screenshot', 'get_jsx', 'get_computed_styles',
  'get_tokens', 'find_nodes'
]);

const WRITE_TOOLS = new Set([
  'write_html', 'update_styles', 'set_text', 'set_text_content',
  'create_artboard', 'duplicate_nodes', 'delete_nodes', 'create_tokens',
  'set_tokens', 'move_nodes'
]);

const PASSTHROUGH_TOOLS = new Set(['finish_working_on_nodes']);

const adapter = {
  classify(name) {
    if (typeof name !== 'string') return 'write';
    if (READ_TOOLS.has(name)) return 'read';
    if (PASSTHROUGH_TOOLS.has(name)) return 'passthrough';
    if (WRITE_TOOLS.has(name)) return 'write';
    return 'write';
  },

  async capture(paper) {
    const basicInfo = await callPaperTool(paper, 'get_basic_info', {});
    const fileId = basicInfo?.file?.id;
    const rootNodeId = basicInfo?.rootNodeId;
    if (!fileId || !rootNodeId) throw new Error('get_basic_info returned no file or page root ID');

    const root = await callPaperTool(paper, 'get_children', { fileId, nodeId: rootNodeId });
    if (!Array.isArray(root?.children) || root.count !== root.children.length) {
      throw new Error('Incomplete page-root children response; refusing a partial snapshot.');
    }
    const targetNodeId = `${fileId}:${rootNodeId}`;
    if (root.count === 0) return { canvas: { [targetNodeId]: [] }, tokens: {} };

    const jsxResult = await callPaperTool(paper, 'get_jsx', { fileId, nodeId: rootNodeId });
    const html = typeof jsxResult === 'string' ? jsxResult : jsxResult?.html ?? jsxResult?.jsx ?? jsxResult?.code;
    if (typeof html !== 'string' || !html.trim()) throw new Error('get_jsx returned empty HTML for a page with children; refusing to fabricate a snapshot.');
    const parsed = parse(html, { lowerCaseTagName: true });
    const emptyWrapper = parsed.childNodes.every(node =>
      node.nodeType === 3 ? !node.text.trim() : node.tagName === 'html' &&
        node.querySelector('body')?.childNodes.every(child => child.nodeType === 3 && !child.text.trim())
    );
    if (emptyWrapper) throw new Error('get_jsx returned an empty wrapper for a page reported to contain nodes; refusing to fabricate a snapshot.');
    return { canvas: { [targetNodeId]: parseHtmlToCanonicalNodes(html) }, tokens: {} };
  },

  normalize(name, args, state) {
    if (name === 'write_html') {
      return normalizeWriteHtml(args, state);
    }
    if (name === 'update_styles') {
      return normalizeUpdateStyles(args, state);
    }
    throw new Error('UNSUPPORTED_MUTATION_PREDICTION');
  },

  replayArgs(name, args, state) {
    if (name !== 'write_html' || typeof args.targetNodeId !== 'string' || typeof args.fileId !== 'string') return args;
    const prefix = `${args.fileId}:`;
    const qualified = args.targetNodeId.startsWith(prefix);
    const nodeId = qualified ? args.targetNodeId.slice(prefix.length) : args.targetNodeId;
    if (qualified && (!nodeId || !Object.hasOwn(state?.canvas ?? {}, `${prefix}${nodeId}`))) {
      throw new Error('write_html target does not match the captured file and page.');
    }
    return { fileId: args.fileId, targetNodeId: nodeId, mode: args.mode, html: args.html };
  },
};

export async function callPaperTool(paper, name, args) {
  const result = await paper.callTool({ name, arguments: args });
  const blocks = Array.isArray(result?.content) ? result.content.filter(block => block.type === 'text' && typeof block.text === 'string') : [];
  const decoded = blocks.map(block => { try { return JSON.parse(block.text); } catch { return block.text; } });
  if (result?.isError === true) throw new Error(`Paper tool ${name} reported an error: ${decoded.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\\n') || 'no error details'}`);
  if (result?.structuredContent !== undefined) return result.structuredContent;
  if (!decoded.length) throw new Error(`No text content from ${name}`);
  if (decoded.length === 1) return decoded[0];
  if (decoded.length === 2 && decoded[0]?.file && decoded[0]?.contentHash && typeof decoded[1] === 'string') return decoded[1];
  if (decoded.length === 2 && decoded[0]?.file && decoded[0]?.contentHash && decoded[1] && typeof decoded[1] === 'object' && !Array.isArray(decoded[1])) return {...decoded[0], ...decoded[1]};
  throw new Error(`Unrecognized multi-block response from ${name}; refusing to discard response data.`);
}

function parseHtmlToCanonicalNodes(html) {
  const root = parse(html, { lowerCaseTagName: true });
  const out = [];
  for (const child of root.childNodes) {
    const node = convertDomNode(child);
    if (node) out.push(node);
  }
  return out;
}

function convertDomNode(domNode) {
  if (!domNode) return null;
  if (domNode.nodeType === 3) {
    const raw = domNode.rawText ?? domNode.text ?? '';
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    return { tag: '#text', attrs: {}, text: raw, children: [] };
  }
  if (domNode.nodeType === 1) {
    const canonical = {
      tag: String(domNode.rawTagName || domNode.tagName || '').toLowerCase(),
      attrs: { ...(domNode.attributes ?? {}) },
      text: '',
      children: [],
    };
    for (const child of domNode.childNodes) {
      const converted = convertDomNode(child);
      if (converted) canonical.children.push(converted);
    }
    return canonical;
  }
  return null;
}

function normalizeWriteHtml(args, state) {
  if (typeof args?.html !== 'string') throw new Error('write_html requires html');
  if (/<style[\s>]/i.test(args.html)) throw new Error('Embedded <style> tags are not supported');
  
  if (typeof args.fileId !== 'string' || typeof args.targetNodeId !== 'string') {
    throw new Error('write_html requires fileId and targetNodeId from the discovered contract.');
  }
  if (!['replace', 'insert-children'].includes(args.mode)) throw new Error('Unsupported write_html mode.');
  const targetId = args.targetNodeId.startsWith(`${args.fileId}:`)
    ? args.targetNodeId
    : `${args.fileId}:${args.targetNodeId}`;
  if (!Object.hasOwn(state?.canvas ?? {}, targetId)) throw new Error('write_html target was not captured in the base snapshot.');
  if (args.mode === 'replace') {
    throw new Error('Paper cannot replace a page root. Use insert-children for a captured empty page.');
  }
  const nodes = parseHtmlToCanonicalNodes(args.html);
  if (state.canvas[targetId].length !== 0) {
    throw new Error('UNSUPPORTED_MUTATION_PREDICTION: insert-children is supported only for a captured empty page root.');
  }
  if (!nodes.length) throw new Error('write_html contains no nodes to stage.');
  // Engine.normalize consumes Mutation {kind:'html', targetNodeId, html};
  // it performs canonical flattening and structural diffing itself.
  return [{ kind: 'html', targetNodeId: targetId, html: args.html }];
}

function normalizeUpdateStyles(args, state) {
  const targetId = args?.targetNodeId ?? args?.targetId ?? args?.nodeId;
  const styles = args?.styles;
  if (!targetId || !styles) throw new Error('update_styles requires targetId and styles');

  const tokenKeys = Object.keys(styles).filter((k) => k.startsWith('--'));
  const nodeKeys = Object.keys(styles).filter((k) => !k.startsWith('--'));

  if (tokenKeys.length > 0 && nodeKeys.length === 0) {
    return tokenKeys.map((name) => ({ type: 'token', name, value: String(styles[name]) }));
  }

  if (nodeKeys.length > 0 && tokenKeys.length === 0) {
    const existing = state?.canvas?.[targetId] || [];
    if (existing.length === 0) throw new Error('UNSUPPORTED_MUTATION_PREDICTION');
    const merged = existing.map((node) => ({
      ...node,
      attrs: { ...(node.attrs ?? {}), style: mergeStyles(node.attrs?.style, styles) },
    }));
    return [{ type: 'node', targetId, nodes: merged }];
  }
  throw new Error('UNSUPPORTED_MUTATION_PREDICTION');
}

function mergeStyles(existingStyle, newStyles) {
  const map = new Map();
  if (typeof existingStyle === 'string') {
    for (const decl of existingStyle.split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      map.set(decl.slice(0, idx).trim(), decl.slice(idx + 1).trim());
    }
  }
  for (const [k, v] of Object.entries(newStyles)) map.set(k, v);
  return Array.from(map.entries()).map(([k, v]) => `${k}: ${v}`).join('; ');
}

export default adapter;
