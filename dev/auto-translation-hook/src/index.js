const ItemsServiceCreator = require("./helper/ItemsServiceCreator");
const CollectionsServiceCreator = require("./helper/CollectionsServiceCreator");
const Translator = require("./Translator");
const TranslatorSettings = require("./TranslatorSettings");
const DirectusCollectionTranslator = require("./DirectusCollectionTranslator");
const getSettingsSchema = require("./schema/schema.js");
const settingsSchemaYAML = getSettingsSchema();
const yaml = require('js-yaml');
const settingsSchema = yaml.load(settingsSchemaYAML);

async function getAndInitItemsServiceCreatorAndTranslatorSettingsAndTranslatorAndSchema(services, database, getSchema, logger) {
    let schema = await getSchema();
    let itemsServiceCreator = new ItemsServiceCreator(services, database, schema);
    let translatorSettings = new TranslatorSettings(services, database, schema);
    await translatorSettings.init();
    let translator = new Translator(translatorSettings, logger);
    await translator.init();
    return {
        itemsServiceCreator: itemsServiceCreator,
        translatorSettings: translatorSettings,
        translator: translator,
        schema: schema
    }
}

async function getCurrentItemForTranslation(itemsService, meta) {
    let currentItem = {}; //For create we don't have a current item
    let primaryKeys = meta?.keys || [];
    for (let primaryKey of primaryKeys) { //For update we have a current item
        currentItem = await itemsService.readOne(primaryKey, {fields: ["translations.*"]});
        break; //we only need get the first primary key
    }
    return currentItem;
}

async function handleFilesTranslations(tablename, payload, meta, context, getSchema, services, logger) {

    let database = context.database;

    let {
        itemsServiceCreator,
        translatorSettings,
        translator,
        schema
    } = await getAndInitItemsServiceCreatorAndTranslatorSettingsAndTranslatorAndSchema(services, database, getSchema, logger);
    
    let autoTranslate = await translatorSettings.isAutoTranslationEnabled();

    if(!autoTranslate){
        return payload;
    }

    let itemsService = await itemsServiceCreator.getItemsService(tablename);

    

    let enrichedPayload = {
        ...payload
    }
    
    if(meta.event == 'items.update'){
        
        let currentItem = await itemsService.readOne(meta.keys[0], {fields: ["*"]});

        enrichedPayload = {
            ...currentItem,
            languages_code: {
                code: currentItem.languages_code,
            },
            ...payload
        }

    }

    if((enrichedPayload?.languages_code !== translatorSettings.translationSource && enrichedPayload?.languages_code?.code !== translatorSettings.translationSource) || !autoTranslate){
        return payload;
    }

    let allTranslations = await itemsService.readByQuery({filter: {
        directus_files_id: {
            _eq: enrichedPayload.directus_files_id,
        }
    }, fields: ["*"]});
    
    const modifiedPayload =  await DirectusCollectionTranslator.modifyPayloadForTranslation({
        translations: allTranslations
    }, {
        translations: {
            create: meta.event === "items.create" ? [enrichedPayload] : [],
            update: meta.event === "items.update" ? [enrichedPayload] : [],
        }
    }, translator, translatorSettings, itemsServiceCreator, schema, 'directus_files');

    let promises = modifiedPayload.translations.create.map((item)=>{
        if(item.languages_code.code === translatorSettings.translationSource || item.languages_code === translatorSettings.translationSource){
            return Promise.resolve();
        }

        return itemsService.createOne({
            ...item,
            directus_files_id: enrichedPayload.directus_files_id
        });
        
    });

    promises.push(...modifiedPayload.translations.update.map((item)=>{
        if(item.languages_code.code === translatorSettings.translationSource || item.languages_code === translatorSettings.translationSource){
            return Promise.resolve();
        }
        return itemsService.updateOne(item.id, item);
    }));

    await Promise.all(promises);

    return payload;

}

async function handleCreateOrUpdate(tablename, payload, meta, context, getSchema, services, logger) {


    if(tablename === 'junction_directus_files_translations'){
        return await handleFilesTranslations(tablename, payload, meta, context, getSchema, services, logger);
    }
    
    if (payload?.translations) {
        let database = context.database; //Have to get database here! https://github.com/directus/directus/discussions/13744

        let {
            itemsServiceCreator,
            translatorSettings,
            translator,
            schema
        } = await getAndInitItemsServiceCreatorAndTranslatorSettingsAndTranslatorAndSchema(services, database, getSchema, logger);

        let autoTranslate = await translatorSettings.isAutoTranslationEnabled();
        if (autoTranslate) {
            let itemsService = await itemsServiceCreator.getItemsService(tablename);
            let currentItem = await getCurrentItemForTranslation(itemsService, meta);
            return await DirectusCollectionTranslator.modifyPayloadForTranslation(currentItem, payload, translator, translatorSettings, itemsServiceCreator, schema, tablename);
        }
    }
    return payload;
}

function registerCollectionAutoTranslation(filter, getSchema, services, logger) {
     let events = [
	    "items.create",
        "items.update",
        "files.items.create",
        "files.items.update",
    ];
    for (let event of events) {
        filter(
            event,
            async (payload, meta, context) => {
                let tablename = meta?.collection;
                return await handleCreateOrUpdate(tablename, payload, meta, context, getSchema, services, logger);
            }
        );
    }
}

async function checkAllCollectionsForMissingTranslations(payload, meta, context, getSchema, services, logger) {
    let database = context.database; //Have to get database here! https://github.com/directus/directus/discussions/13744

    let {
        itemsServiceCreator,
        translatorSettings,
        translator,
        schema
    } = await getAndInitItemsServiceCreatorAndTranslatorSettingsAndTranslatorAndSchema(services, database, getSchema, logger);
    let autoTranslate = await translatorSettings.isAutoTranslationEnabled();
    if (autoTranslate) {
        //let itemsService = await itemsServiceCreator.getItemsService(tablename);

        let currentItem = await getCurrentItemForTranslation(itemsService, meta);
        return await DirectusCollectionTranslator.modifyPayloadForTranslation(currentItem, payload, translator, translatorSettings, itemsServiceCreator, schema, tablename);
    }
}

function registerLanguagesFilter(filter, getSchema, services, logger) {
    const tableName = "languages";
    filter(
        tableName+".items." + "create",
        async (payload, meta, context) => {
            return await checkAllCollectionsForMissingTranslations(payload, meta, context, getSchema, services, logger);
        }
    );
    filter(
        tableName+".items." + "update",
        async (payload, meta, context) => {
            //return await checkAllCollectionsForMissingTranslations(payload, meta, context, getSchema, services, logger);
        }
    );
}


function registerAuthKeyReloader(filter, translator) {
    filter(
        TranslatorSettings.TABLENAME + ".items.update",
        async (payload, meta, context) => {
            if (payload?.auth_key !== undefined) { // Auth Key changed
                try {
                    console.log("registerAuthKeyReloader");
                    await translator.reloadAuthKey(payload?.auth_key); //Try to reload auth key
                    console.log("Censoring api key not")
                    const censoredPayload = await translator.translatorSettings.saveApiKeySecureIfConfiguredAndReturnPayload(payload)
                    const correctObj = await translator.getSettingsAuthKeyCorrectObject(); //

                    payload = {...censoredPayload, ...correctObj}; //Set settings to valid
                    console.log("Final payload at: registerAuthKeyReloader");
                    console.log(JSON.stringify(payload, null, 2))

                } catch (err) { //Auth Key not valid
                    payload = {...payload, ...translator.getSettingsAuthKeyErrorObject(err)};
                }
            }
            return payload;
        }
    );
}

async function checkSettingsCollection(services, database, schema) {
    let collectionsServiceCreator = new CollectionsServiceCreator(services, database, schema);
    let collectionsService = await collectionsServiceCreator.getCollectionsService();
    try {
        let collections = await collectionsService.readByQuery(); //no query params possible !
        let collectionFound = false;
        for (let collection of collections) {
            if (collection.collection === TranslatorSettings.TABLENAME) {
                collectionFound = true;
                break;
            }
        }
        if (!collectionFound) {
            console.log("Collection "+TranslatorSettings.TABLENAME+" not found");
            let settingsSchemaCollection = settingsSchema.collections[0];
            let settingsSchemaFields = settingsSchema.fields;

            console.log("Creating "+TranslatorSettings.TABLENAME+" collection");
             await collectionsService.createOne({
                 ...settingsSchemaCollection,
                 fields: settingsSchemaFields
             });
            console.log("Created "+TranslatorSettings.TABLENAME+" collection");
        } else {
            //console.log("Settings collection found");
        }

    } catch (err) {
        console.log(err);
    }
}

module.exports = async function ({filter, action, init, schedule}, {
    services,
    exceptions,
    database,
    getSchema,
    logger
}) {
    try{
        let schema = await getSchema();
        console.log("Loading Plugin")
        await checkSettingsCollection(services, database, schema)

        let translatorSettings = new TranslatorSettings(services, database, schema);
        await translatorSettings.init();
        let translator = new Translator(translatorSettings, logger);
        await translator.init();
        registerAuthKeyReloader(filter, translator);

        registerCollectionAutoTranslation(filter, getSchema, services, logger);
        //registerLanguagesFilter(filter, getSchema, services, logger); //TODO implement auto translate for new languages
    } catch (err) {
        let errMsg = err.toString();
        if(errMsg.includes("no such table: directus_collections")){
            console.log("++++++++++ Auto Translation +++++++++++");
            console.log("++++ Database not initialized yet +++++");
            console.log("++ Restart Server again after setup +++");
            console.log("+++++++++++++++++++++++++++++++++++++++");
        } else {
            console.log("Auto-Translation init error: ");
            console.log(err);
        }
    }
};
