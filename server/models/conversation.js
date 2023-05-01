const mongoose = require("mongoose");

module.exports = mongoose.model("conversation",
    mongoose.Schema({ 
        conversationID: Number, 
        temperature: { type: Number, default: 1.0 },    
        top_p: { type: Number, default: 1.0 },
        freq_penalty: { type: Number, default: 0.0 },
        pres_penalty: { type: Number, default: 0.0 },
        startingSystemMessage: String,
        messages: [{
            role: String,
            content: String
        }]
    }, { versionKey: false })
); 