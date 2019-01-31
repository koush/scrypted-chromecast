const defaultWebpackConfig = require('scrypted-deploy').getDefaultWebpackConfig();
const merge = require('webpack-merge');
const path = require('path');
const webpack = require('webpack');

const webpackConfig = {
    resolve: {
        alias: {
            ByteBuffer: "bytebuffer",
            Long: "long",
            net: path.resolve(__dirname, 'src/net'),
            tls: path.resolve(__dirname, 'src/tls'),
            fs: path.resolve(__dirname, 'src/fs'),
            mdns: path.resolve(__dirname, 'src/mdns'),
            'safe-buffer': path.resolve(__dirname, 'src/safe-buffer'),
        },
    },
    node: {
        __dirname: true,
    },
}

module.exports = merge(defaultWebpackConfig, webpackConfig);
console.log(module.exports);