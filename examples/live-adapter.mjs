// examples/live-adapter.mjs
import { parse } from 'node-html-parser';

const READ_TOOLS = new Set([
  'get_basic_info',
  'get_selection',
  'get_node_info',
  'get_children',
  'get_tree_summary',
  'get_screenshot',
  'get_jsx',
  'get_computed_styles',
  'get_tokens',
  'find_nodes',
]);

const WRITE_TOOLS = new Set([
  'write_html',
  'update_styles',
  'set_text',
  'set_text_content',
  'create_artboard',
  'duplicate_nodes',
  'delete_nodes',
  'create_tokens',
  'set_tokens',
  'move_nodes',
]);

const PASSTHROUGH_TOOLS = new Set(['finish_working_on_nodes']);

const adapter = {
  independentTextTools: ['set_text_content'],
  classify(name) {
    if (typeof name !== 'string') return 'write';
    if (READ_TOOLS.has(name)) return 'read';
    if (PASSTHROUGH_TOOLS.has(name)) return 'passthrough';
    if (WRITE_TOOLS.has(name)) return 'write';
    return 'write';
  },

  async capture(paper) {
    const requestedFile = process.env.PAPER_MCP_FILE_ID;
    const requestedPage = process.env.PAPER_MCP_PAGE_ID;
    const basicInfo = await callPaperTool(paper, 'get_basic_info', {
      ...(requestedFile ? { fileId: requestedFile } : {}),
      ...(requestedPage ? { pageId: requestedPage } : {}),
    });
    if (
      (requestedFile && basicInfo?.file?.id !== requestedFile) ||
      (requestedPage && basicInfo?.pageId !== requestedPage)
    ) {
      throw new Error(
        'Paper returned a different file or page than the configured capture target.',
      );
    }
    const fileId = basicInfo?.file?.id;
    const rootNodeId = basicInfo?.rootNodeId;
    if (!fileId || !rootNodeId) throw new Error('get_basic_info returned no file or page root ID');

    const root = await callPaperTool(paper, 'get_children', { fileId, nodeId: rootNodeId });
    if (!Array.isArray(root?.children) || root.count !== root.children.length) {
      throw new Error('Incomplete page-root children response; refusing a partial snapshot.');
    }
    const targetNodeId = `${fileId}:${rootNodeId}`;
    if (root.count === 0) return { canvas: { [targetNodeId]: [] }, tokens: {} };

    const canvas = {};
    for (const child of root.children) {
      if (typeof child.id !== 'string')
        throw new Error('Paper returned a child without a node ID.');
      const jsx = await callPaperTool(paper, 'get_jsx', {
        fileId,
        nodeId: child.id,
        format: 'inline-styles',
        includeNodeIds: true,
      });
      const nodes = canonicalSubtree(jsx, child.id);
      const parents = new Set(nodes.map((node) => node.path.slice(0, node.path.lastIndexOf('/'))));
      for (const node of nodes) {
        if (!node.id || parents.has(node.path) || !node.text) continue;
        const info = await callPaperTool(paper, 'get_node_info', { fileId, nodeId: node.id });
        if (info.id !== node.id) throw new Error('Paper returned a different node than requested.');
        if (
          info.component === 'Text' &&
          info.childCount === 0 &&
          typeof info.textContent === 'string'
        ) {
          node.text = info.textContent;
          node.attributes['data-airlock-paper-text'] = 'true';
        }
      }
      canvas[`${fileId}:${child.id}`] = nodes;
    }
    return { canvas, tokens: {} };
  },

  normalize(name, args, state) {
    if (name === 'write_html') {
      return normalizeWriteHtml(args, state);
    }
    if (name === 'set_text_content') return normalizeText(args, state);
    throw new Error('UNSUPPORTED_MUTATION_PREDICTION');
  },

  replayArgs(name, args, state) {
    if (
      name !== 'write_html' ||
      typeof args.targetNodeId !== 'string' ||
      typeof args.fileId !== 'string'
    )
      return args;
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
  const blocks = Array.isArray(result?.content)
    ? result.content.filter((block) => block.type === 'text' && typeof block.text === 'string')
    : [];
  const decoded = blocks.map((block) => {
    try {
      return JSON.parse(block.text);
    } catch {
      return block.text;
    }
  });
  if (result?.isError === true)
    throw new Error(
      `Paper tool ${name} reported an error: ${decoded.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))).join('\\n') || 'no error details'}`,
    );
  if (result?.structuredContent !== undefined) return result.structuredContent;
  if (!decoded.length) throw new Error(`No text content from ${name}`);
  if (decoded.length === 1) return decoded[0];
  if (
    decoded.length === 2 &&
    decoded[0]?.file &&
    decoded[0]?.contentHash &&
    typeof decoded[1] === 'string'
  )
    return decoded[1];
  if (
    decoded.length === 2 &&
    decoded[0]?.file &&
    decoded[0]?.contentHash &&
    decoded[1] &&
    typeof decoded[1] === 'object' &&
    !Array.isArray(decoded[1])
  )
    return { ...decoded[0], ...decoded[1] };
  throw new Error(
    `Unrecognized multi-block response from ${name}; refusing to discard response data.`,
  );
}

function inlineStyles(source) {
  const properties = {};
  const entry =
    /\s*([a-zA-Z][\w]*)\s*:\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|(-?\d+(?:\.\d+)?))\s*(?:,|$)/y;
  while (source.trim()) {
    entry.lastIndex = 0;
    const match = entry.exec(source);
    if (!match) throw new Error('Paper exported an inline style outside the supported JSX subset.');
    const [, key, single, double, number] = match;
    const name = key
      .replace(/^[A-Z]/, (c) => '-' + c)
      .replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())
      .replace(/^--/, '-');
    const value = single ?? double ?? number;
    properties[name] = value.replace(/\\(['"\\])/g, '$1');
    source = source.slice(entry.lastIndex);
  }
  return properties;
}

function canonicalSubtree(result, rootId) {
  const html = typeof result === 'string' ? result : (result?.html ?? result?.jsx ?? result?.code);
  if (typeof html !== 'string' || !html.trim())
    throw new Error('get_jsx returned empty markup; refusing to fabricate a snapshot.');
  const styles = [];
  const markup = html
    .trim()
    .replace(/^\(\s*([\s\S]*)\s*\)$/, '$1')
    .replace(/\bstyle\s*=\s*\{\{([\s\S]*?)\}\}/g, (_, value) => {
      styles.push(inlineStyles(value));
      return `data-airlock-style="${styles.length - 1}"`;
    });
  const nodes = [];
  const seen = new Set();
  const tree = parse(markup, { lowerCaseTagName: true });
  if (tree.children.length !== 1 || tree.children[0].id !== rootId)
    throw new Error(
      'get_jsx did not identify the captured subtree root; refusing to fabricate a snapshot.',
    );
  function visit(parent, parentPath) {
    parent.children.forEach((node, index) => {
      const path = parentPath + '/' + index;
      const {
        id,
        class: classes,
        className,
        ['data-testid']: testid,
        ['data-airlock-style']: styleIndex,
        ...attributes
      } = node.attributes;
      // This marker is reserved for Text nodes independently confirmed by Paper.
      delete attributes['data-airlock-paper-text'];
      if (!id || seen.has(id)) throw new Error('Paper JSX node IDs are missing or ambiguous.');
      seen.add(id);
      nodes.push({
        path,
        tag: node.rawTagName.toLowerCase(),
        id,
        testid: testid ?? null,
        classes: (classes ?? className ?? '').split(/\s+/).filter(Boolean).sort(),
        text: node.childNodes
          .filter((child) => child.nodeType === 3)
          .map((child) => child.text)
          .join('')
          .trim(),
        style: styles[Number(styleIndex)] ?? {},
        attributes,
      });
      visit(node, path);
    });
  }
  visit(tree, '');
  return nodes;
}

function normalizeText(args, state) {
  if (typeof args.fileId !== 'string' || !Array.isArray(args.updates) || args.updates.length !== 1)
    throw new Error('UNSUPPORTED_MUTATION_PREDICTION: use one text layer per call.');
  const seen = new Set();
  return args.updates.map(({ nodeId, html }) => {
    if (
      typeof nodeId !== 'string' ||
      seen.has(nodeId) ||
      typeof html !== 'string' ||
      !html.trim() ||
      html !== html.trim() ||
      /[<>\r\n\t]/.test(html)
    )
      throw new Error(
        'UNSUPPORTED_MUTATION_PREDICTION: use distinct leaves and single-line plain text.',
      );
    seen.add(nodeId);
    const matches = Object.entries(state.canvas).filter(
      ([scope, nodes]) =>
        scope.startsWith(args.fileId + ':') &&
        nodes.some(
          (node) => node.id === nodeId && node.attributes?.['data-airlock-paper-text'] === 'true',
        ),
    );
    if (matches.length !== 1) throw new Error('Text updates require a verified Paper Text layer.');
    return {
      kind: 'node_text',
      targetNodeId: matches[0][0],
      nodeId,
      text: parse(html).textContent,
    };
  });
}

function normalizeWriteHtml(args, state) {
  if (typeof args?.html !== 'string') throw new Error('write_html requires html');
  if (/<style[\s>]/i.test(args.html)) throw new Error('Embedded <style> tags are not supported');

  if (typeof args.fileId !== 'string' || typeof args.targetNodeId !== 'string') {
    throw new Error('write_html requires fileId and targetNodeId from the discovered contract.');
  }
  if (!['replace', 'insert-children'].includes(args.mode))
    throw new Error('Unsupported write_html mode.');
  const targetId = args.targetNodeId.startsWith(`${args.fileId}:`)
    ? args.targetNodeId
    : `${args.fileId}:${args.targetNodeId}`;
  if (!Object.hasOwn(state?.canvas ?? {}, targetId))
    throw new Error('write_html target was not captured in the base snapshot.');
  if (args.mode === 'replace') {
    throw new Error(
      'Paper cannot replace a page root. Use insert-children for a captured empty page.',
    );
  }
  const nodes = parse(args.html).children;
  if (state.canvas[targetId].length !== 0) {
    throw new Error(
      'UNSUPPORTED_MUTATION_PREDICTION: insert-children is supported only for a captured empty page root.',
    );
  }
  if (!nodes.length) throw new Error('write_html contains no nodes to stage.');
  // Engine.normalize consumes Mutation {kind:'html', targetNodeId, html};
  // it performs canonical flattening and structural diffing itself.
  return [{ kind: 'html', targetNodeId: targetId, html: args.html }];
}

export default adapter;
