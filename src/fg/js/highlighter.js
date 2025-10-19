class ODHHighlighter {
    constructor() {
        this.enabled = false;
        this.includeVariants = true;
        this.color = 'rgba(255, 241, 118, 0.8)';
        this.underline = true;
        this.saved = {}; // { lemma: { lemma, forms, lang, addedAt, sourceDict, noteId } }
        this.words = new Set(); // words to highlight (lowercase)
        this.regex = null;
        this.observer = null;
        this.debouncedScan = null;
        this.skipTags = new Set(['SCRIPT','STYLE','TEXTAREA','INPUT','CODE','PRE','HEAD','NOSCRIPT']);
        this.initialized = false;

        this.init();
    }

    async init() {
        await this.loadSavedWords();
        this.compile();
        this.injectStyle();
        this.observeMutations();
        this.highlightDocument();
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' && area !== 'sync') return;
            if (changes.odhSavedWords) {
                this.saved = changes.odhSavedWords.newValue || {};
                this.compile();
                this.refreshHighlights();
            }
        });
    }

    updateOptions(options) {
        const enabled = !!options.highlightEnabled;
        const includeVariants = options.highlightIncludeVariants !== undefined ? !!options.highlightIncludeVariants : this.includeVariants;
        const color = options.highlightColor || this.color;
        const underline = options.highlightUnderline !== undefined ? !!options.highlightUnderline : this.underline;

        const needRehighlight = (this.enabled !== enabled) || (this.includeVariants !== includeVariants) || (this.color !== color) || (this.underline !== underline);
        this.enabled = enabled;
        this.includeVariants = includeVariants;
        this.color = color;
        this.underline = underline;
        this.injectStyle();
        if (needRehighlight) {
            this.compile();
            this.refreshHighlights();
        }
    }

    async loadSavedWords() {
        return new Promise((resolve) => {
            // Try local first, then sync
            chrome.storage.local.get(['odhSavedWords'], (local) => {
                const localVal = local && local.odhSavedWords ? local.odhSavedWords : null;
                if (localVal) {
                    this.saved = localVal || {};
                    resolve();
                } else {
                    try {
                        chrome.storage.sync.get(['odhSavedWords'], (sync) => {
                            this.saved = (sync && sync.odhSavedWords) ? sync.odhSavedWords : {};
                            resolve();
                        });
                    } catch (e) {
                        this.saved = {};
                        resolve();
                    }
                }
            });
        });
    }

    getAllWords() {
        const set = new Set();
        for (const key in this.saved) {
            const rec = this.saved[key];
            if (!rec) continue;
            set.add((rec.lemma || key).toLowerCase());
            if (this.includeVariants && Array.isArray(rec.forms)) {
                for (const f of rec.forms) set.add(String(f).toLowerCase());
            }
        }
        return set;
    }

    compile() {
        this.words = this.getAllWords();
        if (!this.words.size) {
            this.regex = null;
            return;
        }
        // Sort by length desc to prefer longer matches
        const parts = Array.from(this.words).sort((a,b)=>b.length-a.length).map(ODHHighlighter.escapeRegExp);
        // English word boundary by default
        this.regex = new RegExp('\\b(' + parts.join('|') + ')\\b', 'gi');
    }

    injectStyle() {
        if (!this.styleEl) {
            this.styleEl = document.createElement('style');
            this.styleEl.id = 'odh-highlight-style';
            document.documentElement.appendChild(this.styleEl);
        }
        const underlineCss = this.underline ? 'text-decoration: underline; text-decoration-color: rgba(0,0,0,0.15);' : 'text-decoration: none;';
        this.styleEl.textContent = `span.odh-highlight{ background-color: ${this.color}; ${underlineCss} }`;
    }

    observeMutations() {
        if (this.observer) return;
        this.observer = new MutationObserver((mutations) => {
            if (!this.enabled || !this.regex) return;
            if (!this.debouncedScan) {
                this.debouncedScan = this.debounce(() => this.scanMutations(mutations), 100);
            }
            this.debouncedScan();
        });
        this.observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    }

    scanMutations(mutations) {
        const nodes = new Set();
        for (const m of mutations) {
            if (m.type === 'characterData' && m.target && m.target.nodeType === Node.TEXT_NODE) {
                nodes.add(m.target);
            }
            if (m.addedNodes) {
                for (const n of m.addedNodes) {
                    if (n.nodeType === Node.TEXT_NODE) nodes.add(n);
                    else if (n.nodeType === Node.ELEMENT_NODE) this.collectTextNodes(n, nodes);
                }
            }
        }
        this.highlightNodes(Array.from(nodes));
    }

    refreshHighlights() {
        // Remove all previous highlights and re-run
        const highlighted = document.querySelectorAll('span.odh-highlight');
        highlighted.forEach(span => {
            const parent = span.parentNode;
            if (!parent) return;
            // Unwrap
            parent.replaceChild(document.createTextNode(span.textContent), span);
            parent.normalize();
        });
        this.highlightDocument();
    }

    highlightDocument() {
        if (!this.enabled || !this.regex) return;
        const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (!node || !node.parentNode) return NodeFilter.FILTER_REJECT;
                const p = node.parentNode;
                if (p.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_REJECT;
                const tag = p.nodeName.toUpperCase();
                if (this.skipTags.has(tag)) return NodeFilter.FILTER_REJECT;
                if (p.closest && (p.closest('iframe#odh-popup') || p.closest('span.odh-highlight'))) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        const nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        this.highlightNodes(nodes);
    }

    highlightNodes(nodes) {
        if (!this.enabled || !this.regex) return;
        const work = () => {
            const chunk = nodes.splice(0, 50);
            for (const node of chunk) this.highlightTextNode(node);
            if (nodes.length) {
                if (window.requestIdleCallback) requestIdleCallback(work, { timeout: 100 });
                else setTimeout(work, 16);
            }
        };
        work();
    }

    highlightTextNode(node) {
        if (!node || !node.parentNode) return;
        // Avoid re-highlighting inside already highlighted spans
        if (node.parentNode.classList && node.parentNode.classList.contains('odh-highlight')) return;
        const text = node.nodeValue;
        this.regex.lastIndex = 0;
        const m = this.regex.exec(text);
        if (!m) return;
        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        this.regex.lastIndex = 0;
        let match;
        while ((match = this.regex.exec(text)) !== null) {
            const start = match.index;
            const end = start + match[0].length;
            if (start > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, start)));
            const span = document.createElement('span');
            span.className = 'odh-highlight';
            span.setAttribute('data-odh-word', match[0].toLowerCase());
            span.textContent = match[0];
            frag.appendChild(span);
            lastIndex = end;
        }
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        node.parentNode.replaceChild(frag, node);
    }

    collectTextNodes(root, set) {
        if (!root || !root.querySelectorAll) return;
        if (root.closest && root.closest('iframe#odh-popup')) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                const p = node.parentNode;
                if (!p || p.nodeType !== Node.ELEMENT_NODE) return NodeFilter.FILTER_REJECT;
                const tag = p.nodeName.toUpperCase();
                if (this.skipTags.has(tag)) return NodeFilter.FILTER_REJECT;
                if (p.closest && p.closest('span.odh-highlight')) return NodeFilter.FILTER_REJECT;
                if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        while (walker.nextNode()) set.add(walker.currentNode);
    }

    debounce(fn, delay) {
        let t = null;
        return () => {
            if (t) clearTimeout(t);
            t = setTimeout(fn, delay);
        };
    }

    static escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

window.odh_highlighter = new ODHHighlighter();
