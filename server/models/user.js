const mongoose = require("mongoose");

module.exports = mongoose.model("user",
    mongoose.Schema({
        userID: Number, 
        permLevel: Number, // 1 - gpt-3.5-turbo | 2 - gpt-4
    })
); 