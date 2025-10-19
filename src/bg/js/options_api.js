class OptionsAPI{
    async sendtoServiceworker(request){
        request.target='serviceworker';
        try {
            return await chrome.runtime.sendMessage(request);
        } catch (e) {
            return null
        }
    }

    async getDeckNames(){
        return await this.sendtoServiceworker({action:'getDeckNames', params:{}});
    }
    
    async getModelNames(){
        return await this.sendtoServiceworker({action:'getModelNames', params:{}});
    }
    
    async getModelFieldNames(modelName){
        return await this.sendtoServiceworker({action:'getModelFieldNames',params:{modelName}});
    }
    
    async getVersion(){
        return await this.sendtoServiceworker({action:'getVersion',params:{}});
    }

    // Highlighter/Saved words APIs
    async getSavedWords(){
        return await this.sendtoServiceworker({action:'getSavedWords',params:{}});
    }

    async setSavedWords(data){
        return await this.sendtoServiceworker({action:'setSavedWords',params:{data}});
    }

    async deleteSavedWord(lemma){
        return await this.sendtoServiceworker({action:'deleteSavedWord',params:{lemma}});
    }

    async importAnkiWords(){
        return await this.sendtoServiceworker({action:'importAnkiWords',params:{}});
    }

    async exportSavedWords(){
        return await this.sendtoServiceworker({action:'exportSavedWords',params:{}});
    }

    async optionsChanged(options){
        return await this.sendtoServiceworker({action:'optionsChanged',params:{options}});
    }    
}
