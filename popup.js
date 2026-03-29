document.addEventListener('DOMContentLoaded', () => {
    const whitelistTextarea = document.getElementById('whitelist');
    const saveBtn = document.getElementById('saveBtn');
    const sweepBtn = document.getElementById('sweepBtn');
    const statusDiv = document.getElementById('status');
    const importBtn = document.getElementById('importBtn');
    const importFile = document.getElementById('importFile');
    const exportBtn = document.getElementById('exportBtn');

    const defaultWhitelist = ["google.com", "x.com", "twitter.com", "instagram.com", "facebook.com"];

    chrome.storage.local.get(['cookieWhitelist'], (result) => {
        whitelistTextarea.value = result.cookieWhitelist ? result.cookieWhitelist.join('\n') : defaultWhitelist.join('\n');
    });

    function showStatus(message, type = 'success') {
        statusDiv.textContent = message;
        statusDiv.className = `status-msg ${type}`;
        statusDiv.classList.remove('hidden');
        setTimeout(() => statusDiv.classList.add('hidden'), 3000);
    }

    // Prevent "Enter" key from closing the popup globally
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault(); // Aggressively stop Chrome from treating Enter as a "Submit Window" action

            // If they are in the textarea, insert a newline manually since we just blocked the default Enter action
            if (document.activeElement === whitelistTextarea) {
                const start = whitelistTextarea.selectionStart;
                const end = whitelistTextarea.selectionEnd;
                whitelistTextarea.value = whitelistTextarea.value.substring(0, start) + "\n" + whitelistTextarea.value.substring(end);
                // Move cursor down one line
                whitelistTextarea.selectionStart = whitelistTextarea.selectionEnd = start + 1;
            }
        }
    });

    function getCurrentWhitelist() {
        return whitelistTextarea.value.split('\n').map(line => {
            let domain = line.trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
            return domain;
        }).filter(line => line.length > 0);
    }

    saveBtn.addEventListener('click', () => {
        const cleanedList = getCurrentWhitelist();
        chrome.storage.local.set({ cookieWhitelist: cleanedList }, () => {
            whitelistTextarea.value = cleanedList.join('\n');
            showStatus("Whitelist saved!");
        });
    });

    exportBtn.addEventListener('click', () => {
        const blob = new Blob([whitelistTextarea.value], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cookie_sweeper_whitelist.txt';
        a.click();
        URL.revokeObjectURL(url);
    });

    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', (e) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
            whitelistTextarea.value = ev.target.result;
            showStatus('Imported! Click Save.', 'success');
        };
        reader.readAsText(e.target.files[0]);
    });

    sweepBtn.addEventListener('click', async () => {
        // Always grab what's currently in the text area so we never use an outdated list
        const currentList = getCurrentWhitelist();

        // Auto-save it
        await chrome.storage.local.set({ cookieWhitelist: currentList });

        const whitelist = currentList;

        if (!whitelist.length) {
            showStatus("Whitelist empty", "error");
            return;
        }

        // Chrome and Brave are incredibly finicky about the partitionKey object.
        // We must fetch standard cookies AND partitioned cookies separately, then merge them.
        let standardCookies = [];
        let partitionedCookies = [];

        try {
            standardCookies = await chrome.cookies.getAll({});
        } catch (e) {
            console.error("Failed to get standard cookies:", e);
        }

        try {
            partitionedCookies = await chrome.cookies.getAll({ partitionKey: {} });
        } catch (e) {
            console.error("Failed to get partitioned cookies:", e);
        }

        // Merge the two arrays and deduplicate just in case
        const allFetchedCookies = [...standardCookies, ...partitionedCookies];
        const uniqueCookiesMap = new Map();

        allFetchedCookies.forEach(c => {
            // Create a unique key for each cookie based on its critical attributes
            const key = `${c.domain}|${c.path}|${c.name}|${c.storeId}|${c.partitionKey ? JSON.stringify(c.partitionKey) : 'null'}`;
            uniqueCookiesMap.set(key, c);
        });

        const cookies = Array.from(uniqueCookiesMap.values());

        const originsToDelete = [];
        let manualSweepCount = 0;

        // Loop over every single cookie present in the browser
        for (const cookie of cookies) {
            const domain = cookie.domain.startsWith('.') ? cookie.domain.substring(1) : cookie.domain;

            // Check if this specific cookie domain (or its parent) is allowed
            const allowed = whitelist.some(w => domain === w || domain.endsWith('.' + w));

            if (!allowed) {
                // Prepare URLs for bulk browsingData wipe
                originsToDelete.push("https://" + domain);
                originsToDelete.push("http://" + domain);
                originsToDelete.push("https://www." + domain);
                originsToDelete.push("http://www." + domain);

                // FORCE DELETE: BrowsingData sometimes misses partitioned or bizarrely scoped cookies.
                // Try multiple permutations to ensure the cookie origin perfectly matches
                const urlsToTry = [
                    `https://${domain}${cookie.path}`,
                    `http://${domain}${cookie.path}`,
                    `https://www.${domain}${cookie.path}`,
                    `http://www.${domain}${cookie.path}`
                ];

                let deletedCount = 0;
                for (const url of urlsToTry) {
                    try {
                        let removeInfo = {
                            url: url,
                            name: cookie.name,
                            storeId: cookie.storeId
                        };

                        // Critical fix for modern browsers (Chrome/Brave CHIPS):
                        if (cookie.partitionKey) {
                            // Copy the entire partitionKey object back to the API request to perfectly match it
                            removeInfo.partitionKey = cookie.partitionKey;
                        }

                        const result = await chrome.cookies.remove(removeInfo);
                        if (result) deletedCount++;
                    } catch (e) {
                        // Ignore errors for individual manual cookie deletions
                    }
                }
                if (deletedCount > 0) manualSweepCount++;
            }
        }

        // Deduplicate arrays
        const uniqueOrigins = [...new Set(originsToDelete)];

        if (uniqueOrigins.length > 0) {
            // Bulk delete all other data (cache, localstorage, indexedDB) for the blacklisted domains
            // Chunk the array to prevent browser API limits from failing the entire wipe
            const chunkSize = 100;
            for (let i = 0; i < uniqueOrigins.length; i += chunkSize) {
                const chunk = uniqueOrigins.slice(i, i + chunkSize);
                try {
                    await chrome.browsingData.remove({
                        origins: chunk
                    }, {
                        "cache": true,
                        "cacheStorage": true,
                        "cookies": true, // backup net
                        "fileSystems": true,
                        "indexedDB": true,
                        "localStorage": true,
                        "serviceWorkers": true
                    });
                } catch (e) {
                    console.error("Failed to wipe chunk:", e);
                }
            }
        }

        showStatus(`Deep sweep complete! (${manualSweepCount} fragments nuked)`, 'success');
    });
});
