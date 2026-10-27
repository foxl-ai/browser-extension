// A small text-only Markdown renderer. Model output never becomes HTML.
function inline(parent, text) {
  const token = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let start = 0;
  for (const match of text.matchAll(token)) {
    parent.append(document.createTextNode(text.slice(start, match.index)));
    let element;
    if (match[1]) {
      element = document.createElement('strong');
      element.textContent = match[1];
    } else if (match[2]) {
      element = document.createElement('code');
      element.textContent = match[2];
    } else {
      element = document.createElement('a');
      element.href = match[4];
      element.target = '_blank';
      element.rel = 'noreferrer noopener';
      element.textContent = match[3];
    }
    parent.append(element);
    start = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(start)));
}

export function renderMessageText(element, text) {
  const fragment = document.createDocumentFragment();
  const lines = text.split('\n');
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (!paragraph.length) return;
    const p = document.createElement('p');
    inline(p, paragraph.join('\n'));
    fragment.append(p);
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith('```')) {
      flush();
      list = null;
      const code = [];
      while (++index < lines.length && !lines[index].startsWith('```')) code.push(lines[index]);
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      fragment.append(pre);
    } else if (!line.trim()) {
      flush();
      list = null;
    } else if (/^#{1,6} /.test(line)) {
      flush();
      list = null;
      const heading = document.createElement('h3');
      inline(heading, line.replace(/^#{1,6} /, ''));
      fragment.append(heading);
    } else {
      const item = line.match(/^\s*(?:(-|\*|•)|(\d+)[.)])\s+(.+)$/);
      if (item) {
        flush();
        const kind = item[2] ? 'OL' : 'UL';
        if (!list || list.tagName !== kind) {
          list = document.createElement(kind.toLowerCase());
          if (item[2]) list.start = Number(item[2]);
          fragment.append(list);
        }
        const li = document.createElement('li');
        inline(li, item[3]);
        list.append(li);
      } else {
        list = null;
        paragraph.push(line);
      }
    }
  }
  flush();
  element.replaceChildren(fragment);
}
