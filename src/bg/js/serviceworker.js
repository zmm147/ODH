/* global Ankiconnect, Deinflector, Builtin, Agent, optionsLoad, optionsSave */
class ODHServiceworker {
    constructor() {

        this.options = null;

        this.ankiconnect = new Ankiconnect();
        //this.ankiweb = new Ankiweb();
        this.target = null;

        //setup lemmatizer
        this.deinflector = new Deinflector();
        this.deinflector.loadData();

        //Setup builtin dictionary data
        this.builtin = new Builtin();
        this.builtin.loadData();

        chrome.runtime.onMessage.addListener(this.onMessage.bind(this));
        chrome.runtime.onInstalled.addListener(this.onInstalled.bind(this));
        chrome.tabs.onCreated.addListener((tab) => this.onTabReady(tab.id));
        chrome.tabs.onUpdated.addListener(this.onTabReady.bind(this));
        chrome.commands.onCommand.addListener((command) => this.onCommand(command));

        // Context menu for adding highlights from selection
        try {
            chrome.contextMenus.onClicked.addListener((info, tab) => this.onContextMenuClicked(info, tab));
        } catch (e) {
            // ignore if contextMenus permission not available
        }
    }

    onCommand(command) {
        if (command != 'enabled') return;
        this.options.enabled = !this.options.enabled;
        this.setFrontendOptions(this.options);
        optionsSave(this.options);
    }

    onInstalled(details) {
        try {
            chrome.contextMenus.removeAll(() => {
                chrome.contextMenus.create({
                    id: 'odh-highlight-add',
                    title: 'ODH: Highlight selected text',
                    contexts: ['selection']
                });
            });
        } catch (e) {
            // ignore if permission missing
        }

        if (details.reason === 'install') {
            chrome.tabs.create({ url: chrome.runtime.getURL('bg/guide.html') });
            return;
        }
        if (details.reason === 'update') {
            chrome.tabs.create({ url: chrome.runtime.getURL('bg/update.html') });
            return;
        }
    }

    onTabReady(tabId) {
        this.tabInvoke(tabId, {
            action:'setFrontendOptions', 
            params: { 
                options: this.options 
            }
        });
    }

    setFrontendOptions(options) {

        switch (options.enabled) {
            case false:
                chrome.action.setBadgeText({ text: 'off' });
                break;
            case true:
                chrome.action.setBadgeText({ text: '' });
                break;
        }
        this.tabInvokeAll({
            action:'setFrontendOptions',
            params: {
                options
            }
        });
    }

    checkLastError(){
        // NOP
    }

    tabInvokeAll(request) {
        chrome.tabs.query({}, (tabs) => {
            for (let tab of tabs) {
                this.tabInvoke(tab.id, request);
            }
        });
    }

    tabInvoke(tabId, request) {
        const callback = () => this.checkLastError(chrome.runtime.lastError);
        request.target = "frontend"
        chrome.tabs.sendMessage(tabId, request, callback);
    }

    formatNote(notedef) {
        let options = this.options;
        if (!options.deckname || !options.typename || !options.expression)
            return null;

        let note = {
            deckName: options.deckname,
            modelName: options.typename,
            options: { allowDuplicate: options.duplicate == '1' ? true : false },
            fields: {},
            tags: []
        };

        let fieldnames = ['expression', 'reading', 'extrainfo', 'definition', 'definitions', 'sentence', 'url'];
        for (const fieldname of fieldnames) {
            if (!options[fieldname]) continue;
            note.fields[options[fieldname]] = notedef[fieldname];
        }

        let tags = options.tags.trim();
        if (tags.length > 0) 
            note.tags = tags.split(' ');

        if (options.audio && notedef.audios.length > 0) {
            note.fields[options.audio] = '';
            let audionumber = Number(options.preferredaudio);
            audionumber = (audionumber && notedef.audios[audionumber]) ? audionumber : 0;
            let audiofile = notedef.audios[audionumber];
            note.audio = {
                'url': audiofile,
                'filename': `ODH_${options.dictSelected}_${encodeURIComponent(notedef.expression)}_${audionumber}.mp3`,
                'fields': [options.audio]
            };
        }

        return note;
    }

    // Message Hub and Handler start from here ...
    onMessage(request, sender, callback) {
        const { action, params, target} = request;

        if (target != 'serviceworker')
            return;

        const method = this['api_' + action];

        if (typeof(method) === 'function') {
            params.callback = callback;
            method.call(this, params);
        }
        return true;
    }

    async sendtoBackground(request){
        request.target='background';
        try {
            const result =  await chrome.runtime.sendMessage(request);
            return result;
        } catch (e) {
            return null
        }
    }

    // sandbox message handler
    async api_Fetch(params) {
        let { url, callback } = params;

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Response status: ${response.status}`);
            }
        
            const text = await response.text();
            callback(text);
        } catch (e) {
            callback(null);
        }
    }

    async api_Deinflect(params) {
        let { word, callback } = params;
        callback(this.deinflector.deinflect(word));
    }

    async api_getBuiltin(params) {
        let { dict, word, callback } = params;
        callback(this.builtin.findTerm(dict, word));
    }

    async api_getLocale(params) {
        let { callback } = params;
        callback(chrome.i18n.getUILanguage());
    }

    async api_initBackend(params) {
        let options = await optionsLoad();
        await this.optionsChanged(options);
    }

    // Frontend API
    async api_getTranslation(params) {
        let { expression, callback } = params;

        // Fix https://github.com/ninja33/ODH/issues/97
        if (expression.endsWith(".")) {
            expression = expression.slice(0, -1);
        }

        try {
            let result = await this.findTerm(expression);
            callback(result);
        } catch (err) {
            callback(null);
        }
    }

    async api_addNote(params) {
        let { notedef, callback } = params;

        const note = this.formatNote(notedef);
        try {
            let result = await this.target.addNote(note);
            if (result !== null && notedef && notedef.expression) {
                try {
                    await this.upsertSavedWord(notedef.expression, { lang: 'en', sourceDict: this.options ? this.options.dictSelected : undefined, noteId: result });
                } catch (e) {}
            }
            callback(result);
        } catch (err) {
            console.error(err);
            callback(null);
        }
    }

    async api_playAudio(params) {
        let { url, callback } = params;

        try {
            let result = await this.playAudio(url);
            callback(result);
        } catch (err) {
            callback(null);
        }
    }

    // Option page and Brower Action page requests handlers.
    async optionsChanged(options) {
        this.setFrontendOptions(options);

        switch (options.services) {
            case 'none':
                this.target = null;
                break;
            case 'ankiconnect':
                this.target = this.ankiconnect;
                break;
            case 'ankiweb':
                this.target = this.ankiweb;
                break;
            default:
                this.target = null;
        }
        if (this.target !== null && typeof(this.target.initConnection) === 'function')
            await this.target.initConnection(options);

        let defaultscripts = ['builtin_encn_Collins'];
        let newscripts = `${options.sysscripts},${options.udfscripts}`;
        let loadresults = null;
        if (!this.options || (`${this.options.sysscripts},${this.options.udfscripts}` != newscripts)) {
            const scriptsset = Array.from(new Set(defaultscripts.concat(newscripts.split(',').filter(x => x).map(x => x.trim()))));
            loadresults = await this.loadScripts(scriptsset);
        }

        this.options = options;
        if (loadresults) {
            let namelist = loadresults.map(x => x.result.objectname);
            this.options.dictSelected = namelist.includes(options.dictSelected) ? options.dictSelected : namelist[0];
            this.options.dictNamelist = loadresults.map(x => x.result);
        }
        await this.setScriptsOptions(this.options);
        optionsSave(this.options);
    }

    // Option pages API
    async api_optionsChanged(params) {
        let { options, callback } = params;
        await this.optionsChanged(options);
        callback(this.options);
    }

    async api_getDeckNames(params) {
        let { callback } = params;
        callback(this.target ? await this.target.getDeckNames() : null);
    }

    async api_getModelNames(params) {
        let { callback } = params;
        callback(this.target ? await this.target.getModelNames() : null);
    }

    async api_getModelFieldNames(params) {
        let { modelName, callback } = params;
        callback(this.target ? await this.target.getModelFieldNames(modelName) : null);
    }

    async api_getVersion(params) {
        let { callback } = params;
        callback(this.target ? await this.target.getVersion() : null);
    }

    // Sandbox API
    async loadScripts(list) {
        let promises = list.map((name) => this.loadScript(name));
        let results = await Promise.all(promises);
        return results.filter(x => { if (x.result) return x.result; });
    }

    async loadScript(name) {
        return await this.sendtoBackground({action:'loadScript', params:{name}});
    }

    async setScriptsOptions(options) {
        return await this.sendtoBackground({action:'setScriptsOptions', params:{options}});
    }

    async findTerm(expression) {
        return await this.sendtoBackground({action:'findTerm', params:{expression}});
    }

    async playAudio(url) {
        return await this.sendtoBackground({action:'playAudio', params:{url}});
    }

    // ===================== Saved Words & Highlighter support =====================
    getStorageArea() {
        const useSync = this.options && this.options.highlightStorage === 'sync' && chrome.storage.sync;
        return useSync ? chrome.storage.sync : chrome.storage.local;
    }

    async readSavedWords() {
        const area = this.getStorageArea();
        return new Promise((resolve) => {
            try {
                area.get(['odhSavedWords'], (data) => {
                    resolve(data && data.odhSavedWords ? data.odhSavedWords : {});
                });
            } catch (e) {
                resolve({});
            }
        });
    }

    async writeSavedWords(map) {
        const area = this.getStorageArea();
        return new Promise((resolve) => {
            try {
                area.set({ odhSavedWords: map }, () => resolve(true));
            } catch (e) {
                resolve(false);
            }
        });
    }

    englishForms(lemma) {
        const w = String(lemma).toLowerCase();
        const forms = new Set([w]);
        // Plural / 3rd person
        if (/[^aeiou]y$/.test(w)) forms.add(w.replace(/y$/, 'ies'));
        if (/(s|x|z|ch|sh)$/.test(w)) forms.add(w + 'es'); else forms.add(w + 's');
        // Past tense
        if (/e$/.test(w)) forms.add(w + 'd'); else forms.add(w + 'ed');
        // Gerund
        if (/ie$/.test(w)) forms.add(w.replace(/ie$/, 'ying'));
        else if (/e$/.test(w) && !/(ee|ye|oe)$/.test(w)) forms.add(w.slice(0, -1) + 'ing');
        else forms.add(w + 'ing');
        return Array.from(forms);
    }

    async upsertSavedWord(expression, meta = {}) {
        const lemma = String(expression || '').trim().toLowerCase();
        if (!lemma) return false;
        const map = await this.readSavedWords();
        const now = Date.now();
        const current = map[lemma] || { lemma, forms: [], lang: meta.lang || 'en', addedAt: now };
        // generate forms
        try {
            const forms = this.englishForms(lemma);
            current.forms = Array.from(new Set([...(current.forms || []), ...forms]));
        } catch (e) {
            // ignore
        }
        current.addedAt = current.addedAt || now;
        if (meta.sourceDict) current.sourceDict = meta.sourceDict;
        if (meta.noteId) current.noteId = meta.noteId;
        map[lemma] = current;
        await this.writeSavedWords(map);
        return true;
    }

    async onContextMenuClicked(info, tab) {
        if (!info || info.menuItemId !== 'odh-highlight-add') return;
        const text = (info.selectionText || '').trim();
        if (!text) return;
        await this.upsertSavedWord(text, { lang: 'en', sourceDict: 'context' });
    }

    // ============== APIs for options/UI ==============
    async api_getSavedWords(params) {
        const { callback } = params;
        const data = await this.readSavedWords();
        callback(data);
    }

    async api_setSavedWords(params) {
        const { data, callback } = params;
        await this.writeSavedWords(data || {});
        callback(true);
    }

    async api_deleteSavedWord(params) {
        const { lemma, callback } = params;
        const map = await this.readSavedWords();
        if (lemma && map[lemma]) delete map[lemma];
        await this.writeSavedWords(map);
        callback(true);
    }

    async api_importAnkiWords(params) {
        const { callback } = params;
        try {
            if (!this.ankiconnect) { callback(null); return; }
            const deckName = this.options && this.options.deckname ? this.options.deckname : null;
            const typeName = this.options && this.options.typename ? this.options.typename : null;
            const exprField = this.options && this.options.expression ? this.options.expression : null;
            let query = '';
            if (deckName) query += `deck:${deckName}`;
            if (typeName) query += (query ? ' ' : '') + `note:${typeName}`;
            const ids = await this.ankiconnect.ankiInvoke('findNotes', { query });
            if (!ids || !ids.length) { callback(0); return; }
            const infos = await this.ankiconnect.ankiInvoke('notesInfo', { notes: ids });
            let count = 0;
            for (const info of (infos || [])) {
                let expr = null;
                if (info && info.fields && exprField && info.fields[exprField]) {
                    expr = info.fields[exprField].value;
                }
                if (!expr) continue;
                expr = String(expr).replace(/<[^>]*>/g, ' ').trim();
                if (!expr) continue;
                const ok = await this.upsertSavedWord(expr, { lang: 'en', sourceDict: 'anki', noteId: info.noteId || info.id });
                if (ok) count++;
            }
            callback(count);
        } catch (e) {
            callback(null);
        }
    }

    async api_exportSavedWords(params) {
        const { callback } = params;
        const data = await this.readSavedWords();
        callback(JSON.stringify(data));
    }
    }

importScripts('ankiconnect.js');
importScripts('builtin.js');
importScripts('deinflector.js');
importScripts('utils.js');
importScripts('agent.js');

setupOffscreenDocument('/bg/background.html');
odh_serviceworker = new ODHServiceworker();

// according to woxxom's reply on below stackoverflow discussion
// https://stackoverflow.com/questions/66618136/persistent-service-worker-in-chrome-extension
const keepAlive = () => setInterval(chrome.runtime.getPlatformInfo, 20e3);
chrome.runtime.onStartup.addListener(keepAlive);
keepAlive();