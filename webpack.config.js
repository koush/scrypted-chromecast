const defaultWebpackConfig = require('@scrypted/sdk').getDefaultWebpackConfig();
const merge = require('webpack-merge');

const webpackConfig = {
    resolve: {
        alias: {
            ByteBuffer: "bytebuffer",
            Long: "long",
        },
    },
}

module.exports = merge(defaultWebpackConfig, webpackConfig);
