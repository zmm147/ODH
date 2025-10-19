class Ankiconnect {
    constructor() {
        this.version = null;
        this.url = 'http://127.0.0.1:8765'; //define default ankiconnect ip/port
    }

    async initConnection(options) {
        this.url = options.ankiconnecturl;
        this.version = await this.ankiInvoke('version', {}, 100);
    }

    async ankiInvoke(action, params = {}, timeout = 3000) {
        let version = 6;
        let request = { action, version, params };
        try {
            const rawResponse = await fetch(this.url, {
                method: 'POST',
                headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify(request)
            });
            const response = await rawResponse.json();

            if (Object.getOwnPropertyNames(response).length != 2) {
                throw 'response has an unexpected number of fields';
            }
            if (!response.hasOwnProperty('error')) {
                throw 'response is missing required error field';
            }
            if (!response.hasOwnProperty('result')) {
                throw 'response is missing required result field';
            }
            if (response.error) {
                throw response.error;
            }
            return response.result;
        } catch (e) {
            return null;
        }

    }

    async addNote(note) {
        if (note)
            return await this.ankiInvoke('addNote', { note });
        else
            return Promise.resolve(null);
    }

    async getDeckNames() {
        return await this.ankiInvoke('deckNames');
    }

    async getModelNames() {
        return await this.ankiInvoke('modelNames');
    }

    async getModelFieldNames(modelName) {
        return await this.ankiInvoke('modelFieldNames', { modelName });
    }

    async findNotes(query) {
        return await this.ankiInvoke('findNotes', { query });
    }

    async notesInfo(notes) {
        return await this.ankiInvoke('notesInfo', { notes });
    }

    async getVersion() {
        return this.version;
    }
}