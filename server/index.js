'use strict';

/* grab needed vars */
let hookURL = process.env.hookURL;
let mongoURI = process.env.mongoURI;
let openAIKey = process.env.openaiAuth;
let authorization_token = process.env.authorization_token;


/* imports */
const { Configuration, OpenAIApi } = require("openai");
const express = require( 'express' );
const mongoose = require( 'mongoose' );
const { Webhook } = require( 'discord-webhook-node' );
const user = require('./models/user');
const conversation = require('./models/conversation');
const {
    Tiktoken
} = require("@dqbd/tiktoken/lite");
const {
    load
} = require("@dqbd/tiktoken/load");
const registry = require("@dqbd/tiktoken/registry.json");
const models = require("@dqbd/tiktoken/model_to_encoding.json");


/* logging system used for setup */
function log ( _in_ ) {
    let hook = new Webhook( hookURL );
    hook.send( _in_ ); 
    console.log( _in_ );
}

async function countTokens ( content ) {

    const model = await load(registry[models["gpt-4"]]);
    const encoder = new Tiktoken(model.bpe_ranks, model.special_tokens, model.pat_str);
    const tokens = encoder.encode(content);
    encoder.free();

    return tokens.length;
}

function trimConversation(conversation, newMessageTokens) {
    const maxTokens = 7600;
    let tokenCount = conversation.messages.reduce((acc, msg) => acc + countTokens(msg.content), 0) + newMessageTokens;

    while (tokenCount > maxTokens && conversation.messages.length > 0) {
        const removedMessage = conversation.messages.shift();
        tokenCount -= countTokens(removedMessage.content);
    }

    return conversation;
}

/* server setup/config */
const app = express( );
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded( { extended: false } ))

app.use( (err, req, res, next) => {
    res.locals.error = err;
    const status = err.status || 500;
    res.status( status );
    res.render( 'error' ) ;
});

app.listen(64133, () => {
    log( '[server] listening for requests!' );
})

/* connect to database */ 
mongoose.connect( mongoURI , {
    useNewUrlParser: true,
    useUnifiedTopology: true
}).then( ( ) => log( '[server] connected to database' ) );

/* gpt config */
const configuration = new Configuration({
    apiKey: openAIKey
})

const openai = new OpenAIApi(configuration);

app.post('/api/registeruser', async (req, res) => {

    /* 
        userID: Number, 
        permLevel: Number, 
        dailyLimit: Number, 
        limitedAccess: String -> boolean
        authorization: String
    */

    if (req.body.authorization == authorization_token) {
        
        let alreadyExistsEntry = await user.findOne({ userID: req.body.userID });

        if ( alreadyExistsEntry !== null ) 
            return res.send("User was already registered.");
    
        let registerPayload = {
            userID: req.body.userID,
            permLevel: req.body.permLevel,
            dailyLimit: req.body.dailyLimit,
            limitedAccess: ((req.body.limitedAccess).toLowerCase() === 'true'),
        };

        user.create(registerPayload);

        log("Created user with User ID" + req.body.userID);

    } else return log("failed authorization attempt from " + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));


    return res.send("User registered");

});

app.post('/api/removeuser', async (req, res) => {

    /* 
        userID: Number
    */

    if (req.body.authorization == authorization_token) {
        
        let existsEntry = await user.findOne({ userID: req.body.userID });

        if ( existsEntry == null ) 
            return res.send("No such user found.");

        await user.deleteOne({ userID: req.body.userID });

        log("Deleted user with user ID " + req.body.userID);

    } else return log("failed authorization attempt from " + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));


    return res.send("User deleted");

});

app.post('/api/validateconversation', async (req, res) => {

    /* 
        convID: number
    */

    if (req.body.authorization == authorization_token) {
        
        let existsEntry = await conversation.findOne({ conversationID: req.body.convID });

        if ( existsEntry == null ) 
            return res.send("no"); 
        return res.send("yes");

    } else return log("failed authorization attempt from " + (req.headers['x-forwarded-for'] || req.socket.remoteAddress));


});

app.post('/api/chatcompletion', async (req, res) => {
    console.log("Starting /api/chatcompletion");

    if (req.body.authorization == authorization_token) {
        console.log("User authorization passed");

        let userEntry = await user.findOne({ userID: req.body.userID });
        console.log("User entry found:", userEntry);

        if (userEntry == null)
            return res.send("Failed to authorize user from cluster.");

        let startingSystemMessage;

        if ((req.body.startingSystemMessage).toUpperCase() == "DEFAULT")
            startingSystemMessage = "You are a helpful assistant";
        else startingSystemMessage = req.body.startingSystemMessage;

        console.log("Starting system message:", startingSystemMessage);

        let conversationEntry = await conversation.findOne({ conversationID: req.body.conversationID });
        console.log("Conversation entry found:", conversationEntry);

        if (conversationEntry == null) {
            let emptyConv = [{ 'role': 'system', 'content': startingSystemMessage }];
            let newConvPayload = {
                conversationID: req.body.conversationID,
                temperature: req.body.temperature,
                top_p: req.body.top_p,
                freq_penalty: req.body.freq_penalty,
                pres_penalty: req.body.pres_penalty,
                messages: emptyConv
            };

            console.log("Creating new conversation entry");
            await conversation.create(newConvPayload);
            console.log("New conversation entry created");
        }

        let newUserMessageEntry = {
            'role': 'user',
            'content': req.body.message
        };

        let convEntry = await conversation.findOne({ conversationID: req.body.conversationID });

        convEntry.messages.push(newUserMessageEntry);

        convEntry = trimConversation(convEntry, 0);

        await conversation.updateOne({ conversationID: req.body.conversationID }, { messages: convEntry.messages });

        if (userEntry.permLevel == 1) {
            console.log("User permLevel is 1");

        
            const messages = convEntry.messages.map(({ role, content }) => ({ role, content }));


            console.log("[dbg]\n Messages array:", messages);
            console.log("Temperature:", convEntry.temperature);
            console.log("Top_p:", convEntry.top_p);
            console.log("Frequency_penalty:", convEntry.freq_penalty);
            console.log("Presence_penalty:", convEntry.pres_penalty);

            console.log("Calling OpenAI API");
            const response = await openai.createChatCompletion({
                model: "gpt-3.5-turbo",
                messages: messages,
                n: 1,
                temperature: parseInt(convEntry.temperature),
                top_p: parseInt(convEntry.top_p),
                frequency_penalty: parseInt(convEntry.freq_penalty),
                presence_penalty: parseInt(convEntry.pres_penalty)
            });
            console.log("OpenAI API response:", response);

            await console.dir(response.data.choices);

            const messageContent = await response.data.choices[0].message.content.trim();

            let newAssistantMsgEntry = {
                'role': 'assistant',
                'content': response.data.choices[0].message.content.trim()
            };

            try {
                console.log("Updating conversation with new assistant message");
                await conversation.updateOne({
                    conversationID: req.body.conversationID
                }, {
                    $push: {
                        messages: newAssistantMsgEntry
                    }
                });
                console.log("Conversation updated with new assistant message");

            } catch (err) {
                log("[server] post-api: failed to add message to conversation");

                return res.send("Failed to add message to current conversation");
            }

            const promptTokens = await response.data.usage.prompt_tokens;
            const completionTokens = await response.data.usage.completion_tokens;

            return res.json({
                messageContent: messageContent,
                promptTokens: promptTokens,
                completionTokens: completionTokens,
            });

        } else if (userEntry.permLevel == 2) {
            console.log("User permLevel is 2");;
        
            const messages = convEntry.messages.map(({ role, content }) => ({ role, content }));


            console.log("[dbg]\n Messages array:", messages);
            console.log("Temperature:", convEntry.temperature);
            console.log("Top_p:", convEntry.top_p);
            console.log("Frequency_penalty:", convEntry.freq_penalty);
            console.log("Presence_penalty:", convEntry.pres_penalty);
            
            const response = await openai.createChatCompletion({
                model: "gpt-4",
                messages: messages,
                n: 1,
                temperature: parseInt(convEntry.temperature),
                top_p: parseInt(convEntry.top_p),
                frequency_penalty: parseInt(convEntry.freq_penalty),
                presence_penalty: parseInt(convEntry.pres_penalty)
            });

            await console.log(response);

            const messageContent = await response.data.choices[0].message.content.trim();
            const promptTokens = await response.data.usage.prompt_tokens;
            const completionTokens = await response.data.usage.completion_tokens;

            let newAssistantMsgEntry = {
                'role': 'assistant',
                'content': response.data.choices[0].message.content.trim()
            };

            try {
                console.log("Updating conversation with new assistant message");
                await conversation.updateOne({
                    conversationID: req.body.conversationID
                }, {
                    $push: {
                        messages: newAssistantMsgEntry
                    }
                });
                console.log("Conversation updated with new assistant message");

            } catch (err) {
                log("[server] post-api: failed to add message to conversation");

                return res.send("Failed to add message to current conversation");
            }

            
            console.log(messageContent);
            
            return res.send(JSON.stringify({messageContent: messageContent, promptTokens: promptTokens, completionTokens: completionTokens }));
            
            

        }

        return res.send("Error in calling the OpenAI API.");

    } else return log("failed authorization attempt from " + req.headers['x-forwarded-for'] || req.socket.remoteAddress);
});

            
