/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let port = browser.runtime.connectNative("hiddiwalker");

port.onMessage.addListener((response) => {
    console.log(`Received: ${response}`);
});

function Setup() {
    let config = {
        mode: "fixed_servers",
        rules: {
            singleProxy: {
                scheme: "http",
                host: "127.0.0.1",
                port: 12334
            },
            bypassList: ["<local>"]
        }
    };

    browser.proxy.settings.set({
        value: config,
        scope: "regular"
    }).then(() => {
        console.log("Proxy setup succesful");
    }).catch((error) => {
        console.error("Proxy has failed to start:", error);
    });

    chrome.browserAction.onClicked.addListener(() => {
        //chrome.tabs.create({url: "http://localhost:6756/ui/?secret=-oLqenny7-qz8EFD"});
        console.log("Sending:   ping");
        port.postMessage("ping");
    });
}


browser.runtime.onStartup.addListener(Setup);

Setup();