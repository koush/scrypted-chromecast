const defaultWebpackConfig = require('scrypted-deploy').getDefaultWebpackConfig();
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
