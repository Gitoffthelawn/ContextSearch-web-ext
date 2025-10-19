function hasUserScriptsExecute() {
	let browser = chrome || browser;
	return typeof browser?.userScripts?.execute === 'function';
}

// chrome - run a quick check for loaded objects
if ( typeof importScripts === 'function' && typeof findNode === 'undefined' ) {
	importScripts(
		"lib/browser-polyfill.min.js",
		"utils.js",
		"update_useroptions.js",
		"opensearch.js",
		"lib/encoding-indexes.js",
		"lib/encoding.min.js",
		"defaultEngines.js",
		"bookmarks.js",
		"defaultUserOptions.js",
		"contexts.js",
		"searchActions.js",
		"nodes.js",
		"omnibox.js",
		"searchEngineUtils.js",
		"keyTable.js",
		"TabHighlighter.js",
		"Shortcuts.js",
		"tools.js",
		"contextMenu.js"
	)
}

// global variables

// context menu entries need to be tracked to be updated
self.contextMenuMatchRegexMenus = [];
self.tabTerms = [];
self.searchTerms = "";
self.searchTermsObject = {};
self.popupWindows = [];

var userOptions = {};
var highlightTabs = [];
var platformInfo = null;
var isLoadingUserOptions = false;
var tabHighlighter = new TabHighlighter();

// tracks tabs by index that have findbar search results when searching all tabs
// var markedTabs = [];

browser.runtime.getPlatformInfo().then( info => platformInfo = info );

// init
(async () => {
	isLoadingUserOptions = true;
	await loadUserOptions();
	debug("userOptions loaded. Updating objects");
	userOptions = await updateUserOptionsVersion(userOptions);
	await repairNodeTree(userOptions.nodeTree, false);
	await browser.storage.local.set({"userOptions": userOptions});
	await checkForOneClickEngines();
	await buildContextMenu();
	resetPersist();
	setIcon();
	isLoadingUserOptions = false;

	// permission and userScripts.execute checks run in function
	registerAllUserScripts();
})();

// catch permissions added for Firefox
browser.permissions.onAdded.addListener( async permissions => {	
	if ( permissions.userScripts)
		updateUserScripts();
});

// listeners
if ( browser.contextMenus ) // catch android
	browser.contextMenus.onClicked.addListener(contextMenuSearch);

// domain follower highlighting
browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {

	// skip data URIs
	if ( tab.url.startsWith("data:")) return;

	if ( !userOptions.highLight.followDomain && !userOptions.highLight.followExternalLinks ) return;

	if ( changeInfo.status !== 'complete' || tab.url === 'about:blank') return;
		
	let url = new URL(tab.url);

	let highlightInfo = highlightTabs.find( ht => ( ht.tabId === tabId || ht.tabId === tab.openerTabId ) && ( ( userOptions.highLight.followExternalLinks && ht.domain !== url.hostname ) || ( userOptions.highLight.followDomain && ht.domain === url.hostname ) ) );
	
	if ( highlightInfo ) {
		console.log('found openerTabId ' + tab.openerTabId + ' in hightlightTabs');
		highlightSearchTermsInTab(tab, highlightInfo.searchTerms);
	}
});

browser.tabs.onRemoved.addListener(tabId => {
	notify({action: "removeTabHighlighting", tabId: tabId});
});

browser.tabs.onRemoved.addListener(tabId => removeTabTerms(tabId));
browser.tabs.onActivated.addListener(info => deactivateTabTerms(info.tabId));
browser.tabs.onActivated.addListener(info => {
	if ( userOptions.quickMenuCloseOnTabChange && typeof info.previousTabId !== 'undefined' ) {
		browser.tabs.sendMessage(info.previousTabId, {action: "cancelQuickMenuRequest"}).then(() => {}, () => {});
		browser.tabs.sendMessage(info.previousTabId, {action: "closeQuickMenuRequest"}).then(() => {}, () => {});
	}
});

{	// popup window listeners
	let handler = async (id) => {
		// not a CS popup window
		if ( !self.popupWindows.includes(id) ) return;

		let w = await browser.windows.get(id);
		userOptions.popupWindow.height = w.height + "px";
		userOptions.popupWindow.width = w.width + "px";
		userOptions.popupWindow.left = w.left + "px";
		userOptions.popupWindow.top = w.top + "px";
		notify({action: "saveUserOptions", userOptions:userOptions});
	}

	browser.windows.onFocusChanged.addListener(async id => handler(id));

	browser.windows.onRemoved.addListener(id => {
		self.popupWindows = self.popupWindows.filter(_id => _id !== id );
		//handler(id);
	});
}

browser.runtime.onMessage.addListener(notify);

browser.runtime.onInstalled.addListener( details => {
 
	// details.reason = 'install';
	// Show new features page
	
	self.addEventListener('loadUserOptions', () => {
	
	/*
		if (
			details.reason === 'update' 
			&& details.previousVersion < "1.9.4"
		) {
			browser.tabs.create({
				url: browser.runtime.getURL("/options.html#highLight"),
				active: false
				
			}).then(_tab => {
				browser.tabs.executeScript(_tab.id, {
					file: browser.runtime.getURL("/update/update.js")
				});
			});
		}
		
	//	Show install page
*/	if ( details.reason === 'install' ) {
			browser.tabs.create({
				url: "/options.html#engines"
			}).then(_tab => {
				_executeScript({
					func: () => cacheAllIcons(),
					tabId: _tab.id
				});
			});
		}
	});
});

// trigger zoom event
browser.tabs.onZoomChange.addListener( async zoomChangeInfo => {

	let tab = await browser.tabs.get(zoomChangeInfo.tabId);

	if ( !isValidHttpUrl(tab.url) ) return;

	_executeScript({
		func: () => document.dispatchEvent(new CustomEvent("zoom")),
		tabId: zoomChangeInfo.tabId
	}).catch(error => console.log(error))
});

async function notify(message, sender, sendResponse) {

	function sendMessageToTopFrame() {
		return browser.tabs.sendMessage(sender.tab.id, message, {frameId: 0});
	}
	
	function sendMessageToAllFrames() {
		return browser.tabs.sendMessage(sender.tab.id, message);
	}
	
	sender = sender || {};
	if ( !sender.tab ) { // page_action & browser_action popup has no tab, use current tab
		let onFound = tabs => sender.tab = tabs[0];
		let onError = err => console.error(err);
		
		await browser.tabs.query({currentWindow: true, active: true}).then(onFound, onError);
	}

	try {
		//console.log(sender.tab.id, sender.tab.url, message.action);
	} catch (error) {}

	if ( message.sendMessageToTopFrame ) {
		return sendMessageToTopFrame();
	}

	if ( message.sendMessageToAllFrames ) {
		return sendMessageToAllFrames();
	}

	switch(message.action) {

		case "saveUserOptions":
			userOptions = message.userOptions;

			console.log("saveUserOptions", message.source || "", sender.tab.url);

			return browser.storage.local.set({"userOptions": userOptions}).then(() => {
				notify({action: "updateUserOptions", source: sender});
			});

		case "updateUserOptions":

			debounce(async () => {
				console.log('updateUserOptions');
				let tabs = await getAllOpenTabs();
				for (let tab of tabs) {
					browser.tabs.sendMessage(tab.id, {"userOptions": userOptions, source: message.source}).catch( error => {/*console.log(error)*/});	
				}
				buildContextMenu();
			}, 1000, "updateUserOptionsTimer");

			if ( typeof browser.userScripts?.execute !== 'function' ) {
				debounce(async () => {
					console.log('updateUserScripts');
					updateUserScripts();
				}, 2000, "updateUserScriptsTimer");
			}
			return;
			
		case "openOptions": {
			let optionsPageURL = browser.runtime.getURL("/options.html");
			let optionsPage = await browser.tabs.query({url: optionsPageURL + "*"});

			optionsPage = optionsPage.shift();

			if ( optionsPage ) {
				browser.windows.update(optionsPage.windowId, {focused: true})
				browser.tabs.update(optionsPage.id, { active: true, url: browser.runtime.getURL("/options.html" + (message.hashurl || "")), openerTabId: sender.tab.id});
			//	browser.tabs.reload(optionsPage.id);
				return optionsPage;

			}
			return browser.tabs.create({
				url: browser.runtime.getURL("/options.html" + (message.hashurl || "")) 
			});
		}
			
		case "quickMenuSearch":
		case "search":
			message.info.tab = sender.tab;
			return openSearch(message.info);
			
		case "enableContextMenu":
			userOptions.contextMenu = true;
			return buildContextMenu();

		case "fetchURI":
			return new Promise((resolve, reject) => {
				fetch(message.url)
					.then(response => response.blob())
					.then(blob => {
						let reader = new FileReader();
						reader.onloadend = () => {
							resolve(reader.result);
						};
						reader.onerror = reject;
						reader.readAsDataURL(blob);
					})
					.catch(reject);
			});
			
		case "getUserOptions":
			return userOptions;
			
		case "getDefaultUserOptions":
			return defaultUserOptions;

		case "dispatchEvent":

			return _executeScript({
				func: (evt) => document.dispatchEvent(new CustomEvent(evt)),
				args: [message.e],
				tabId: sender.tab.id,
				allFrames:true
			});

		case "openQuickMenu":
			return sendMessageToTopFrame();
			
		case "closeQuickMenuRequest":
			return sendMessageToAllFrames();
		
		case "quickMenuIframeLoaded":
			return sendMessageToTopFrame();
		
		case "updateQuickMenuObject":
			return sendMessageToAllFrames();
			
		case "lockQuickMenu":
			return sendMessageToTopFrame();
			
		case "unlockQuickMenu":
			return sendMessageToTopFrame();

		case "deselectAllText":
			return sendMessageToAllFrames();

		case "toggleLockQuickMenu":

			return _executeScript({
				tabId: sender.tab.id,
				func: () => {
					if ( quickMenuObject && quickMenuObject.locked ) unlockQuickMenu(); else lockQuickMenu();
				},
				tabId: sender.tab.id,
				allFrames: true

			})
			
		case "rebuildQuickMenu":
			return sendMessageToTopFrame();
			
		case "closeWindowRequest":
			return browser.windows.remove(sender.tab.windowId);
		
		case "closeCustomSearch":
			return sendMessageToTopFrame();
			
		case "openFindBar":
			if ( userOptions.highLight.findBar.openInAllTabs ) {
				let _message = Object.assign({}, message);
				
				if ( !userOptions.highLight.findBar.searchInAllTabs )
					_message.searchTerms = "";
				
				let tabs = await getAllOpenTabs();

				return Promise.all(tabs.map( async tab => {
					await waitOnInjection(tab.id);
					await highlightInjectScripts(tab);
					return browser.tabs.sendMessage(tab.id, ( tab.id !== sender.tab.id ) ? _message : message, {frameId: 0});
				}));
				
			} else {
				await waitOnInjection(sender.tab.id);
				await highlightInjectScripts(sender.tab);
				return sendMessageToTopFrame();
			}
			
		case "closeFindBar":
			if ( userOptions.highLight.findBar.openInAllTabs ) {
				
				let tabs = await getAllOpenTabs();
				return Promise.all(tabs.map( tab => {
					return browser.tabs.sendMessage(tab.id, message, {frameId: 0});
				}));
				
			} else
				return sendMessageToTopFrame();
			
		case "showFindBar": 
			return _executeScript({
				tabId: sender.tab.id,
				func: () => showFindBar()
			});

		case "updateFindBar":
			return sendMessageToTopFrame();

		case "toggleFindBar":
			let isOpen = await notify({action: "getFindBarOpenStatus"});

			//let searchTerms = ( typeof getSelectedText === 'function' ) ? getSelectedText(e.target) : "";
			let s = await _executeScript({
				func: () => ( typeof getSelectedText === 'function' ) ? getSelectedText(document.activeElement) : "",
				tabId: sender.tab.id
			});

			if (!isOpen || ( isOpen && s) )
				notify({action: "openFindBar", searchTerms: s});
			else
				notify({action: "closeFindBar"});
			return;
			
		case "findBarNext":
			return sendMessageToTopFrame();
			
		case "findBarPrevious":
			return sendMessageToTopFrame();
		
		case "getFindBarOpenStatus":

			return _executeScript({
				func: () => (typeof getFindBar !== 'undefined' && getFindBar()) ? true : false,
				tabId: sender.tab.id
			});

		case "mark":

			// clear highlighted tabs on new markings
			if ( userOptions.highLight.findBar.highlightAllTabs )
				tabHighlighter.clear();

			const injectAllFrames = async tab => {
				let frames = await browser.webNavigation.getAllFrames({tabId: tab.id});

				for ( let frame of frames ) {
					if ( frame.frameId == 0 ) continue;
					await injectContentScripts(tab, frame.frameId);
					await highlightInjectScripts(tab);
				}
			}

			await injectAllFrames(sender.tab);

			if ( message.findBarSearch && userOptions.highLight.findBar.searchInAllTabs ) {
				let tabs = await getAllOpenTabs();

				for ( let tab of tabs )	{
					await injectAllFrames(tab);
					await highlightInjectScripts(tab);
				}

				return Promise.all(tabs.map( tab => browser.tabs.sendMessage(tab.id, message)));
			} else {
				return sendMessageToAllFrames();
			}

			
		case "unmark":
			if ( userOptions.highLight.findBar.highlightAllTabs )
				tabHighlighter.clear();
			return sendMessageToAllFrames();
		
		case "findBarUpdateOptions":
			return sendMessageToTopFrame();

		case "markDone":
			if ( message.count && userOptions.highLight.findBar.highlightAllTabs )
				tabHighlighter.add(sender.tab.index);
			
			return sendMessageToTopFrame();
			
		case "toggleNavBar":
			return sendMessageToTopFrame();
			
		case "closeSideBar":
			return sendMessageToTopFrame();
		
		case "openSideBar":
		case "sideBarHotkey":
			await executeScripts(sender.tab.id, {files: ["/dock.js", "resizeWidget.js", "/inject_sidebar.js"]}, true);
			return sendMessageToTopFrame();

		case "makeOpeningTab":
			return sendMessageToTopFrame();
			
		case "getOpenSearchLinks":

			return _executeScript({
				func: () => {
						let oses = document.querySelectorAll('link[type="application/opensearchdescription+xml"]');
						if ( oses ) return [...oses].map( ose => {return {title: ose.title || document.title, href: ose.href }});
					},
				tabId: sender.tab.id,
				frameId: message.frame ? sender.frameId : 0
			});

		case "updateSearchTerms":

			debug(self.searchTermsObject);

			self.searchTerms = message.searchTerms;
			self.searchTermsObject = message.searchTermsObject;
			
			if ( userOptions.autoCopy && message.searchTerms && ( userOptions.autoCopyOnInputs || !message.input))
				notify({action: "copy", autoCopy:true});
			//	notify({action: "copy", msg: message.searchTerms});
			
			return browser.tabs.sendMessage(sender.tab.id, message, {frameId: 0});
			
		case "updateContextMenu":
		
			return updateContextMenu(message);
			
		case "getFirefoxSearchEngineByName": {
			if ( !browser.search || !browser.search.get ) return [];
			let engines = await browser.search.get();
			return engines.find(e => e.name === message.name);
		}
			
		case "addSearchEngine": {
			let url = message.url;

			if ( browser.runtime.getBrowserInfo && browser.search && browser.search.get ) {

				// skip for Firefox version < 78 where window.external.AddSearchProvider is available
				let info = await browser.runtime.getBrowserInfo();	
				if ( parseFloat(info.version) < 78 ) return;
				
				let match = /SHORTNAME=(.*?)&DESCRIPTION/.exec(url);	
				
				if (!match[1]) return;

				let title = decodeURIComponent(match[1]);
				
				let engines = await browser.search.get();
				
				if ( engines.find(e => e.name === title) ) {

					return await _executeScript({
						func: (title) => alert(browser.i18n.getMessage("FFEngineExists", title)),
						args: [title],
						tabId: sender.tab.id
					});
				}

				await _executeScript({
					file: "/addSearchProvider.js",
					tabId: sender.tab.id
				});
				
				const exists = await _executeScript({
					func: (title) => getSearchProviderUrlByTitle(title),
					args: [title],
					tabId: sender.tab.id
				});

				if ( exists ) {
					console.log('OpenSearch engine with name ' + title + ' already exists on page');

					let oldURL = new URL(exists);
					let newURL = new URL(url);

					if ( oldURL.href == newURL.href ) {
						console.log('exists but same url');
					} else {
						console.log('open new tab to include fresh opensearch link');
						
						let favicon = sender.tab.favIconUrl;
						
						let tab = await browser.tabs.create({
							active:true,
							url: browser.runtime.getURL('addSearchProvider.html')
						});

						await _executeScript({
							func: (favicon) => {
								var userOptions = {};

								browser.runtime.sendMessage({action: "getUserOptions"}).then( uo => {
									userOptions = uo;
								});
								
								setFavIconUrl(favicon);
							},
							args: [favicon],
							tabId: tab.id
						});

						// some delay needed
						await new Promise(r => setTimeout(r, 500));

						notify({action: "addSearchEngine", url: url});
						return;
					}
				}

				await _executeScript({
					func: (url) => addSearchProvider(url),
					args: [url],
					tabId: sender.tab.id
				});
					
			}
			
			self.external.AddSearchProvider(url);
			break;
		}
		
		case "addContextSearchEngine": {
		
			let se = message.searchEngine;
			
			console.log('addContextSearchEngine', se)
			
			if (nameExists(se.title)) {
				sendResponse({errorMessage: 'Name must be unique. Search engine already exists'});
				return;
			}
			
			se.id = gen();

			let parentNode = message.folderId ? findNode(userOptions.nodeTree, n => n.id === message.folderId) : userOptions.nodeTree;
						
			let node = {
				type: "searchEngine",
				title: se.title,
				id: se.id,
				hidden: false,
				contexts:32
			}
			parentNode.children.push(Object.assign(node, se));

			notify({action: "saveUserOptions", userOptions:userOptions});
			return node;
			
		}
			
		case "removeContextSearchEngine":

			if ( !message.id ) return;

			removeNodesById(userOptions.nodeTree, message.id);
	
			notify({action: "saveUserOptions", userOptions:userOptions});
			
			break;
			
		case "testSearchEngine":
			
			openSearch({
				searchTerms: message.searchTerms,
				tab: sender.tab,
				temporarySearchEngine: message.tempSearchEngine,
				openMethod: message.openMethod || "openBackgroundTab"
			});

			break;
			
		case "enableAddCustomSearchMenu":

			if (!userOptions.contextMenuShowAddCustomSearch) return;

			try {
				browser.contextMenus.update("add_engine", { visible: true }).then(() => {
					if (browser.runtime.lastError)
						console.log(browser.runtime.lastError);
				});
			} catch (err) {
				console.log(err);
			}

			break;
		
		case "disableAddCustomSearchMenu":
			
			try {
				browser.contextMenus.update("add_engine", { visible: false }).then(() => {
					if (browser.runtime.lastError)
						console.log(browser.runtime.lastError);
				});
			} catch (err) {
				console.log(err);
			}
			break;

		case "log":
			console.log(message, sender);
			break;
			
		case "focusSearchBar":
			browser.tabs.sendMessage(sender.tab.id, message);
			break;
			
		case "setLastSearch":
			browser.storage.session.set({"lastSearch": message.lastSearch});
			break;
			
		case "getLastSearch":
			return await browser.storage.session.get("lastSearch");
			
		case "getCurrentTheme":
			browser.theme.getCurrent().then( theme => {
				console.log(theme);
			});
			break;
			
		case "executeTestSearch": {

			let searchTerms = encodeURIComponent(message.searchTerms);
			let searchRegex = new RegExp(searchTerms + "|" + searchTerms.replace(/%20/g,"\\+") + "|" + searchTerms.replace(/%20/g,"_"), 'g');
			
			let timeout = Date.now();

			let urlCheckInterval = setInterval( () => {
				browser.tabs.get(sender.tab.id).then( tabInfo => {
					
					if (tabInfo.status !== 'complete') return;

					if ( searchRegex.test(tabInfo.url) ) {
						
						clearInterval(urlCheckInterval);
						
						let newUrl = tabInfo.url.replace(searchRegex, "{searchTerms}");
						
						let se = message.badSearchEngine;
						
						se.template = newUrl;

						browser.tabs.sendMessage(tabInfo.id, {action: "openCustomSearch", searchEngine: se}, {frameId: 0});
					}
					
					// No recognizable GET url. Prompt for advanced options
					if (Date.now() - timeout > 5000) {

						console.log('urlCheckInterval timed out');
						browser.tabs.sendMessage(tabInfo.id, {action: "openCustomSearch", timeout: true}, {frameId: 0});
						clearInterval(urlCheckInterval);
					}

				});
			}, 1000);
			
			return true;
			
		}

		case "copy":
			await CopyPaste.copy(message.msg || self.searchTerms)
				.catch(error => {
					debug(error);
					return browser.tabs.sendMessage(sender.tab.id, message, {frameId: 0});
				}).catch(error => {
					console.log(error);
					return false;
				});
			
		case "hasBrowserSearch":
			return typeof browser.search !== 'undefined' && typeof browser.search.get !== 'undefined';
			
		case "checkForOneClickEngines":	
			return checkForOneClickEngines();
			
		case "getCurrentTabInfo": 
			return Promise.resolve(sender.tab);
		
		case "removeTabHighlighting": {
		
			let tabId = message.tabId || sender.tab.id;
			highlightTabs.findIndex( (hl, i) => {
				if (hl.tabId === tabId) {
					highlightTabs.splice(i, 1);
					console.log('removing tabId ' + tabId + ' from array');
					return true;
				}
			});

			break;
		}
			
		case "dataToSearchEngine":
			return dataToSearchEngine(message.formdata);
		
		case "showNotification":
			return sendMessageToTopFrame();
			
		case "getTabQuickMenuObject":

				return Promise.race([
					new Promise(async r => {
						try {
							if ( !isAllowedURL(sender.tab.url) ) return r(null);
							if ( await isTabScriptable(sender.tab.id) === false ) return r(null);

							const qmo = await browser.tabs.sendMessage(sender.tab.id, {action: "getQuickMenuObject"});

							// console.log(sender.tab);
							// console.log(qmo);
							r(qmo);
						} catch (error) { r(null); }}),
					new Promise(r => setTimeout(r, 250))
				])
					
		
		case "addToHistory": {

			if ( sender.tab.incognito && userOptions.incognitoTabsForgetHistory ) return console.log('incognito - do not add to history')
	
			let terms = message.searchTerms.trim();
			
			if ( !terms ) return;

			// send last search to backgroundPage for session storage
			notify({action: "setLastSearch", lastSearch: terms});
			
			// return if history is disabled
			if ( ! userOptions.searchBarEnableHistory ) return;

			// remove first entry if over limit
			if (userOptions.searchBarHistory.length >= userOptions.searchBarHistoryLength)
				userOptions.searchBarHistory.shift();

			(() => { // ignore duplicates
				let index = userOptions.searchBarHistory.indexOf(terms);
				if ( index !== -1 )
					userOptions.searchBarHistory.splice(index, 1);
			})();
			
			// add new term
			userOptions.searchBarHistory.push(terms);

			// update prefs
			notify({action: "saveUserOptions", "userOptions": userOptions, source: "addToHistory" });
			
			console.info('adding to history', terms);
			return Promise.resolve(userOptions);
		}
			
		case "setLastOpenedFolder":
			self.lastOpenedFolder = message.folderId;
			return true;
			
		case "getLastOpenedFolder":
			return self.lastOpenedFolder || null;

		case "executeScript": //UserScript

			return _executeScript({
				func: () => message.code,
				tabId: sender.tab.id
			});

		case "injectContentScripts":

			while ( isLoadingUserOptions )
				await new Promise(r => setTimeout(r, 50));
			if ( isAllowedURL(sender.tab.url)) {
				injectContentScripts(sender.tab, sender.frameId);
			} else {
				console.log("blacklisted", sender.tab.url);
			}
			break;
			
		case "injectComplete":

			if ( userOptions.quickMenu ) {
				await executeScripts(sender.tab.id, {files: ["/dock.js", "/resizeWidget.js","/dragshake.js"], frameId: 0}, true);
				await executeScripts(sender.tab.id, {files: ["/inject_quickmenu.js"], frameId: sender.frameId}, true);
			}

			if ( userOptions.pageTiles.enabled ) {
				await executeScripts(sender.tab.id, {files: ["/inject_pagetiles.js"], frameId: sender.frameId}, true);
				await executeScripts(sender.tab.id, {files: ["/dragshake.js"], frameId: 0}, true);
			}
			
			if ( /\/\/mycroftproject.com/.test(sender.tab.url) && userOptions.modify_mycroftproject ) 
				await executeScripts(sender.tab.id, {files: ["/searchEngineUtils.js", "/inject_mycroftproject.js"], frameId: sender.frameId});
			
			break;
			
		case "getFirefoxSearchEngines":
			if ( browser.search && browser.search.get ) return browser.search.get();
			break;
			
		case "setLastUsed":
			lastSearchHandler(message.id, message.method || null);
			break;
			
		case "getSelectedText":

			return _executeScript({
				func: () => ( typeof getSelectedText === 'function' ) ? getSelectedText(document.activeElement) : "",
				tabId: sender.tab.id
			});

		case "editQuickMenu":
			sendMessageToTopFrame();
			break;

		case "closePageTiles":
			return sendMessageToTopFrame();

		case "openBrowserAction":
			console.log('openBrowserAction');
			if ( browser.action ) // v3
				browser.action.openPopup();
			else if ( browser.browser_action ) // v2
				browser.browser_action.openPopup();
			return;

		case "openPageTiles":
			return sendMessageToTopFrame();

		case "minifySideBar":
			console.log('bg');
			return sendMessageToTopFrame();

		case "getZoom":
			return browser.tabs.getZoom(sender.tab.id);

		case "sideBarOpenedOnSearchResults":

			return await _executeScript({
				func: () => {
					(() => {
						let result = window.openedOnSearchResults;
						delete window.openedOnSearchResults;
						return result;
					})();
				},
				tabId: sender.tab.id
			})

		case "openCustomSearch":
			sendMessageToTopFrame();
			break;

		case "getRawSelectedText":

			return await _executeScript({
				func: () => getRawSelectedText(document.activeElement),
				tabId: sender.tab.id
			})

		case "updateUserOptionsObject":
			return updateUserOptionsObject(message.userOptions);

		case "updateUserOptionsVersion":
			return updateUserOptionsVersion(message.userOptions);

		case "requestPermission":
			return browser.permissions.request({permissions: [message.permission]});

		case "hasPermission":
			return hasPermission(message.permission);

		case "openTab":
			return openWithMethod(message);

		case "closeTab":
			return browser.tabs.remove(message.tabId || sender.tab.id )

		case "getIconsFromIconFinder":
			return browser.tabs.create({
				url: "https://www.iconfinder.com/search?q=" + message.searchTerms.toLowerCase(),
				active:false
			}).then(async tab => {
				await new Promise(r => setTimeout(r, 1000));

				let urls = await _executeScript({
					func: () => [...document.querySelectorAll(".icon-grid IMG")].map(img => img.src),
					tabId: tab.id
				});

				browser.tabs.remove(tab.id);
				return urls;
			});

		case "cancelQuickMenuRequest":
			sendMessageToTopFrame();
			break;

		case "download":
			if ( !await hasPermission("downloads") ) {
				let optionsTab = await notify({action: "openOptions", hashurl:"?permission=downloads#requestPermissions"});
				return;
			}

			return browser.downloads.download({url: message.url, saveAs: true});

		case "getBookmarksAsNodeTree":
			return await CSBookmarks.treeToFolders(message.id || "root________");

		case "getTabTerms":
			return self.tabTerms.find(t => t.tabId === sender.tab.id);

		case "isSidebar":
			return sender.hasOwnProperty("frameId");

		case "disablePageClicks":
			if ( !userOptions.toolBarMenuDisablePageClicks ) return;
			if ( !isAllowedURL(sender.tab.url) ) return;
			if ( await isTabScriptable(sender.tab.id) === false ) return;

			return _insertCSS({
				tabId: sender.tab.id, 
				css: "HTML{pointer-events:none;}",
				allFrames: true
			}).catch( error => debug(error) );;

		case "enablePageClicks":
			if ( !userOptions.toolBarMenuDisablePageClicks ) return;

			async function logTabs(tabs) {
			  for (const tab of tabs) {
			  	if ( !isAllowedURL(tab.url) ) continue;
				if ( await isTabScriptable(tab.id) === false ) continue;
				
				_removeCSS({
					tabId: tab.id, 
					css: "HTML{pointer-events:none;}",
					allFrames: true
				}).catch( error => debug(error) );
			  }
			}

			return browser.tabs.query({}).then(logTabs);

		// bypasses Firefox resistFingerprinting
		case "getDevicePixelRatio":
			return self.devicePixelRatio;

		case "setSessionClipboard":
			console.log('set', message.clipboardObject);
			return browser.storage.session.set({"clipboard": message.clipboardObject});

		case "getSessionClipboard":
			return browser.storage.session.get("clipboard")
				.then(r => r.clipboard?.message || "");
	}
}

function checkUserOptionsValueTypes(repair) {
	const traverse  = (obj, obj2) => {
		Object.keys(obj).forEach(key => {

			if ( typeof obj[key] !== typeof obj2[key]) {
				console.error('mismatched object types', key, typeof obj[key], typeof obj2[key], obj[key], obj2[key]);

				if ( repair ) {
					console.log('repairing');
					obj2[key] = Object.assign({}, obj[key]);
				}
			}

			if (typeof obj[key] === 'object' && obj[key] instanceof Object ) {
				traverse(obj[key], obj2[key])
			}
		})
	}

	traverse(defaultUserOptions, userOptions);
}

function updateUserOptionsObject(uo) {
	// Update default values instead of replacing with object of potentially undefined values
	function traverse(defaultobj, userobj) {
		for (let key in defaultobj) {
			userobj[key] = (userobj[key] !== undefined && userobj[key] == userobj[key] ) ? userobj[key] : JSON.parse(JSON.stringify(defaultobj[key]));

			if (typeof userobj[key] !== typeof defaultobj[key] ) {
				console.error(key, "mismatched types");
				userobj[key] = defaultobj[key];
			}

			if ( defaultobj[key] instanceof Object && Object.getPrototypeOf(defaultobj[key]) == Object.prototype && key !== 'nodeTree' )
				traverse(defaultobj[key], userobj[key]);

			// fix broken object arrays but skip searchEngines
			if ( defaultobj[key] instanceof Array && defaultobj[key][0] && defaultobj[key][0] instanceof Object && key !== "searchEngines" ) {
				
				if ( userobj[key].includes( undefined ) ) {
					console.error(key, "Found broken settings array in config. Restoring defaults")
					userobj[key] = JSON.parse(JSON.stringify(defaultobj[key]));
				}

				for(let i=userobj[key].length-1;i>-1;i--) {
					try {
						String(userobj[key][i]);
					} catch (e) {
						console.error('Dead objects found. Replacing with defaults');
						userobj[key] = JSON.parse(JSON.stringify(defaultobj[key]));
						break;
					}
				}
			}

			// fix broken values
			if ( typeof defaultobj[key] === 'number' && ( typeof userobj[key] !== 'number' || !isFinite(userobj[key]) ) ) {
				console.error(key, userobj[key], "Found broken value. Restoring default");
				userobj[key] = JSON.parse(JSON.stringify(defaultobj[key]));
			}
		}
	}

	traverse(defaultUserOptions, uo);
	
	return uo;
}

function loadUserOptions() {
	
	function onGot(result) {
		
		// no results found, use defaults
		if ( !result.userOptions ) {
			userOptions = Object.assign({}, defaultUserOptions);
			return false;
		}

		userOptions = updateUserOptionsObject( result.userOptions );

		return true;
	}
  
	function onError(error) {
		console.log(`Error: ${error}`);
	}

	var getting = browser.storage.local.get("userOptions");
	return getting.then(onGot, onError);
}

function openWithMethod(o) {
	if ( !o.url ) return;
	
	o.openerTabId = o.openerTabId || null;
	o.index = o.index || null;

	function filterOptions(_o) {
		if ( platformInfo && platformInfo.os === "android") delete _o.openerTabId;

		return _o;
	}
	
	switch (o.openMethod) {
		case "openCurrentTab":
			o.openerTabId = null; // Cannot set a tab's opener to itself
			return openCurrentTab();

		case "openNewTab":
			return openNewTab(false);

		case "openNewWindow":
			return openNewWindow(false);

		case "openNewIncognitoWindow":
			return openNewWindow(true);

		case "openBackgroundTab":
		case "openBackgroundTabKeepOpen":
			return openNewTab(true);

		case "openSideBarAction":
			return openSideBarAction(o.url);

		case "openPopup":
			return openPopup();
	}
	
	function openCurrentTab() {
		
		return browser.tabs.update(filterOptions({
			url: o.url,
			openerTabId: o.openerTabId
		}));
	} 
	function openNewWindow(incognito) {	// open in new window

		return browser.windows.create({
			url: o.url,
			incognito: incognito
		});
	} 
	async function openNewTab(inBackground) {	// open in new tab

		if ( userOptions.forceOpenResultsTabsAdjacent ) {
			try {
				let tabs = await browser.tabs.query({currentWindow: true});
				let active = tabs.find(t => t.active === true );
				let tabChildren = tabs.filter(t => t.openerTabId === active.id);
				let indexes = tabChildren.map(t => t.index);
				o.index = Math.max(...indexes, active.index) + 1;

			} catch (err) {
				console.log(err);
			}
		}

		return browser.tabs.create(filterOptions({
			url: o.url,
			active: !inBackground,
			openerTabId: o.openerTabId,
			index: o.index
			//openerTabId: (info.folder ? null : openerTabId)
		}));

	}	

	async function openSideBarAction(url) {

		if ( !browser.sidebarAction ) return;
		
		await browser.sidebarAction.setPanel( {panel: null} ); // firefox appears to ignore subsequent calls to setPanel if old url = new url, even in cases of differing #hash
		
		await browser.sidebarAction.setPanel( {panel: url} );
			
		if ( !await browser.sidebarAction.isOpen({}) )
			notify({action: "showNotification", msg: i18n('NotificationOpenSidebar')}, {});

		return {};
	}

	async function openPopup() {
		const getDimension = (d,dname=null,tab=null) => {
			if ( /\d+$/g.test(d) || /\d+px$/g.test(d) ) {
				return parseInt(d);
			}

			if ( /d+%/g.test(d) ) {
				
			}
		}

		let tabs = await browser.tabs.query({currentWindow: true, active: true});
		let tab = tabs[0];
		let zoom = await browser.tabs.getZoom(tab.id);

		// reuse the first tab in the current window
		if ( userOptions.popupWindow.reuse && self.popupWindows.length ) {
			let _tabs = await browser.tabs.query({windowId: self.popupWindows[0]});
			return browser.tabs.update(_tabs[0].id, {url: o.url});
		}

		let qmo = await notify({action: "getTabQuickMenuObject"});

		qmo = qmo || { screenCoords: {x: 0, y: 0}};
		let w = await browser.windows.create({
			url:o.url,
			height:getDimension(userOptions.popupWindow.height),
			width: getDimension(userOptions.popupWindow.width),
			top: userOptions.popupWindow.rememberPosition ? 
				getDimension(userOptions.popupWindow.top) :
				parseInt(qmo.screenCoords.y * zoom),
			left: userOptions.popupWindow.rememberPosition ? 
				getDimension(userOptions.popupWindow.left) :
				parseInt(qmo.screenCoords.x * zoom),
			type: "panel"
		});
		
		self.popupWindows.push(w.id);
		return w;
	}
}

function executeBookmarklet(info) {

	const blobCode = (c, s) => {
		return `
			(() => {
			  const blob = new Blob([\`CS_searchTerms = searchTerms = "` + s + `";` + c + `\`], {
			    type: "text/javascript",
			  });
			  let script = document.createElement('script');
			  script.src = URL.createObjectURL(blob);
			  script.type = 'text/javascript';

			  document.getElementsByTagName('head')[0].appendChild(script);
			})();
		`
	}

	const vanillaCode = (c, s) => {
		return `CS_searchTerms = searchTerms = "${s}";${c}`;
	}

	//let searchTerms = info.searchTerms || window.searchTerms || escapeDoubleQuotes(info.selectionText);
	let searchTerms = escapeDoubleQuotes(info.searchTerms || info.selectionText || self.searchTerms);

	// run as script
	if ( info.node.searchCode ) {

		const code = userOptions.scriptsUseBlobs 
			? blobCode(info.node.searchCode, searchTerms) 
			: vanillaCode(info.node.searchCode, searchTerms);

		return browser.tabs.query({currentWindow: true, active: true}).then( async tabs => {
			return executeUserScript({
				tabId: tabs[0].id, 
				code: code, 
				nodeId: info.node.id
			});
		});
	}

	if (!browser.bookmarks) {
		console.error('No bookmarks permission');
		return;
	}

	// run as bookmarklet
	browser.bookmarks.get(info.menuItemId).then( bookmark => {
		bookmark = bookmark.shift();
		
		if (!bookmark.url.startsWith("javascript")) { // assume bookmark
		
			openWithMethod({
				openMethod: info.openMethod, 
				url: bookmark.url,
				openerTabId: userOptions.disableNewTabSorting ? null : info.tab.id
			});

			return false;
		}
		
		browser.tabs.query({currentWindow: true, active: true}).then( async tabs => {
			let code = decodeURI(bookmark.url);

			// UserScript
			return executeUserScript({
				tabId: tabs[0].id, 
				code: code,
				nodeId: info.node.id
			});
		});

	}, error => {
		console.error(error);
	});
}

function executeOneClickSearch(info) {

	let searchTerms = info.searchTerms || info.selectionText;
	let openMethod = info.openMethod;
	let openerTabId = userOptions.disableNewTabSorting ? null : info.tab.id;
	
	if ( !info.multiURL )
		notify({action: "addToHistory", searchTerms: searchTerms});

	async function searchAndHighlight(tab) {

		browser.search.search({
			query: searchTerms,
			engine: info.node.title,
			tabId: tab.id
		});

		browser.tabs.onUpdated.addListener(async function listener(tabId, changeInfo, __tab) {
			
			if ( tabId !== tab.id ) return;
		
			if ( changeInfo.status !== 'complete' || __tab.url === 'about:blank' ) return;

			browser.tabs.onUpdated.removeListener(listener);

			highlightSearchTermsInTab(__tab, searchTerms);

		});
	}
	
	function onError(error) {
		console.log(`Error: ${error}`);
	}
	
	if ( openMethod === "openSideBarAction" ) {
		return console.log("one-click search engines cannot be used with sidebaraction");
	}
	
	openWithMethod({
		openMethod: openMethod, 
		url: "about:blank",
		openerTabId: openerTabId
	}).then( async tab => {
		// if new window
		if (tab.tabs) tab = tab.tabs[0];

		let start = Date.now();

		if ( !info.multiURL )
			addTabTerms(info.node, tab.id, searchTerms);

		browser.tabs.onUpdated.addListener(async function listener(tabId, changeInfo, __tab) {
			if ( tabId !== tab.id ) return;
		
			if ( changeInfo.status !== 'complete' ) return;

			browser.tabs.onUpdated.removeListener(listener);

			debug('tab took', Date.now() - start );

			// .search.get() requires some delay
			await new Promise(r => setTimeout(r, 500));

			searchAndHighlight(tab);
		});

	}, onError);

}

async function executeExternalProgram(info) {

	let node = info.node;
	let searchTerms = info.searchTerms || info.selectionText;
	let downloadURL = null;
	let downloadPath = null;

	if ( node.searchRegex ) {
		try {
			runReplaceRegex(node.searchRegex, (r, s) => searchTerms = searchTerms.replace(r, s));
		} catch (error) {
			console.error("regex replace failed");
		}
	}

	let path = node.path.replace(/{searchTerms}/g, searchTerms)
		.replace(/{url}/g, info.tab.url);


	/* check for prompts */
	const rx = /(?:\{prompt(?:=(.+?))\})/g;
	var match;
	let new_path = path;
	while ((match = rx.exec(path)) != null) {

		let str = await promptCurrentTab(match[1]);

		// check for cancel
		if (str === null) return;
		new_path = new_path.replace(match[0], str);
	}

	path = new_path;
	/* end check for prompts */

	// confirm the path is correct
	//if ( !await confirmCurrentTab(`"${escapeDoubleQuotes(path)}"`) ) return;
	
	// {download_url} is a link to be downloaded by python and replaced by the file path
	let matches = path.match(/{download_url(?:=(.+))?}/);
	if ( matches ) {
		downloadURL = searchTerms;
		downloadPath = matches[1] || null;
	}

	/* download using browser UI */

	if ( /^ask$/i.test(downloadPath) ) {

		let id = await browserSaveAs(downloadURL);

		// chrome does not wait on file naming
		// use interval to check download status

		if ( chrome ) {
			let status = "";

			browser.downloads.onChanged.addListener(info => {

				if ( info.error ) status = "error";
				if ( info.state && info.state.current === 'complete' ) status = "complete";
			});

			await new Promise(r => {
				let ival = setInterval( () => {
					if ( status ) {
						clearInterval(ival);
						r();
					}
				}, 1000);
			});

			if ( status === "error" ) {
				return console.error("download failed");
			}
		}

		let dl = await browser.downloads.search({id: id});

		if ( dl.length )
			path = path.replace(/{download_url=ask}/i, dl[0].filename);
		else
			return console.error("download failed");
	}

	/* end download using browser UI */

	if ( !await hasPermission("nativeMessaging")) {
		let tabs = await browser.tabs.query({active:true});
		let tab = tabs[0];
		let optionsTab = await notify({action: "openOptions", hashurl:"?permission=nativeMessaging#requestPermissions"});
		browser.tabs.onRemoved.addListener( function handleRemoved(tabId, removeInfo) {
			browser.tabs.onRemoved.removeListener(handleRemoved);
			setTimeout(() => browser.tabs.update(tab.id, {active: true}), 50);
		});
	}

	if ( ! await hasPermission("nativeMessaging") ) return;

	try {
		await browser.runtime.sendNativeMessage("contextsearch_webext", {verify: true});
	} catch (error) {
		return notify({action: "showNotification", msg: i18n('NativeAppMissing')})
	}

	let msg = {
		path: path, 
		cwd:node.cwd, 
		return_stdout: ( node.postScript ? true : false ), 
		downloadURL: downloadURL, 
		downloadFolder: downloadPath || userOptions.nativeAppDownloadFolder || null 
	};

	debug("native app message ->", msg);

	return browser.runtime.sendNativeMessage("contextsearch_webext", msg).then( async result => {
		if ( node.postScript.trim() ) {

			let code = 'let result = `' + escapeBackticks(result) + '`;\n' + node.postScript;

			// UserScript
			await executeUserScript({
				tabId: info.tab.id, 
				code: code,
				nodeId: node.id,
				nativeAppResult: result // for Firefox w/o userScripts.execute()
			});
		}
	});
}

function lastSearchHandler(id, method) {

	let node = findNode(userOptions.nodeTree, n => n.id === id );
	
	if ( !node ) return;
	
	userOptions.lastUsedId = id;
	userOptions.lastOpeningMethod = method;
	
	if ( node.type !== "folder" ) {
		userOptions.recentlyUsedList.unshift(userOptions.lastUsedId);
		userOptions.recentlyUsedList = [...new Set(userOptions.recentlyUsedList)].slice(0, userOptions.recentlyUsedListLength);
	}
	
	notify({action: "saveUserOptions", userOptions: userOptions, source: "lastSearchHandler"});
}

function isValidHttpUrl(str) {
	let url;

	// skip data URIs
	if ( str.startsWith("data:")) return false;

	try {
		url = new URL(str);
	} catch(e) {
		return false;  
	}

	return url.protocol === "http:" || url.protocol === "https:";
}

async function openSearch(info) {

	if ( info.openMethod === "openSideBarAction" ) {
		console.log('open Firefox sidebar');
		browser.sidebarAction.open();
	}
	
	if ( info.node && info.node.type === "folder" ) return folderSearch(info);

	var searchTerms = (info.searchTerms || info.selectionText || "").trim();

	var openMethod = info.openMethod || "openNewTab";
	var tab = info.tab || {url:"", id:0};
	var temporarySearchEngine = info.temporarySearchEngine || null; // unused now | intended to remove temp engine
	var domain = info.domain || null;
	var node = info.node || findNode(userOptions.nodeTree, n => n.id === info.menuItemId) || null;
	info.node = info.node || node; // in case it wasn't sent
	var openerTabId = userOptions.disableNewTabSorting ? null : tab.id;

	// openAsLink
	if ( info.openUrl ) {

		let q = searchTerms;
		if (searchTerms.match(/^.*:\/\//) === null)
			q = "http://" + searchTerms;

		return openWithMethod({
			openMethod: openMethod, 
			url: q, 
			openerTabId: openerTabId == -1 ? null : openerTabId // chrome pdf reader gives tab.id of -1
		}).then(onCreate, onError);
	}
	
	if (!info.folder) delete self.folderWindowId;
	
	if ( !info.temporarySearchEngine && !info.folder && !info.openUrl) 
		lastSearchHandler(info.menuItemId, info.openMethod);

	if ( userOptions.preventDuplicateSearchTabs ) {
		try {
			let oldTab = await getTabTermsTab(node.id, searchTerms);
			console.log('tab with same engine and terms exists');
			return false;
		} catch ( error ) {}
	}

	if ( userOptions.multilinesAsSeparateSearches && !info.multilines ) {

		try {

			if ( info.quickMenuObject && isSameStringMinusLineBreaks(info.quickMenuObject.lastSelectText, info.quickMenuObject.searchTermsObject.selection) ) {
				searchTerms = info.quickMenuObject.lastSelectText;
				debug('multiline search', 'DOM menu');
			}
			else if ( info.selectionText && isSameStringMinusLineBreaks(info.selectionText, self.searchTerms)){
				searchTerms = self.searchTerms;
				debug('multiline search', 'context menu');
			}

		} catch (err) {
			console.error(err);
		}

		// filter empty lines
		let terms = searchTerms.trim().split('\n').filter(l => l);

		if ( terms.length > 1 ) {

			let ps = [];

			if ( terms.length > userOptions.multilinesAsSeparateSearchesLimit ) {

				// try to inject confirm dialog
				try {
					let valid = await _executeScript({
						func: () => hasRun,
						tabId: info.tab.id
					});

					if ( valid ) {
						let _confirm_str = i18n("ConfirmMultiLineSearch", terms.length.toString());
						
						const _confirm = await _executeScript({
							func: (_confirm_str) => confirm(_confirm_str),
							args: [ _confirm_str],
							tabId: info.tab.id
						});

						// let _confirm = null;
						// if ( browser?.scripting?.executeScript ) { // v3
						// 	confirm = await browser.scripting.executeScript({
						// 		target: {
						// 			tabId: info.tab.id
						// 		},
						// 		func: (_confirm_str) => confirm(_confirm_str),
						// 		args: [ _confirm_str]
						// 	}).then(result => result.shift().result);
						// } else { // v2
						// 	_confirm = await browser.tabs.executeScript(info.tab.id, { code:`confirm('${_confirm_str}');` })
						// 		.then(result => result.shift())
						// }

						if ( !_confirm ) return;
					}
				} catch ( err ) { // can't inject a confirm dialog
					console.log(err);
					return;
				}
			}

			terms.forEach((t, i) => {
				t = t.trim();

				if ( !t ) return;

				let _info = Object.assign({}, info);
				_info.searchTerms = t;
				_info.multilines = true;
				_info.openMethod = i ? "openBackgroundTab" : _info.openMethod;
				delete _info.quickMenuObject;

				ps.push(openSearch(_info));
			})

			Promise.all(ps);
			return;
		}
	}

	if ( node && node.type === "oneClickSearchEngine" ) {
		console.log("oneClickSearchEngine");
		return executeOneClickSearch(info);
	}
	
	//if (browser.bookmarks !== undefined && !userOptions.searchEngines.find( se => se.id === info.menuItemId ) && !info.openUrl ) {
	if ( node && node.type === "bookmarklet" ) {
		console.log("bookmarklet");
		return executeBookmarklet(info);
	}

	if ( node && node.type === "externalProgram" ) {
		console.log("externalProgram");
		return executeExternalProgram(info);
	}

	// from multisearch folderSearch()
	if ( node && node.type === "temporarySearchEngine" ) {
		temporarySearchEngine = node;
	}

	//var se = temporarySearchEngine || userOptions.searchEngines.find(_se => _se.id === node.id ) : temporarySearchEngine || null;
	var se = temporarySearchEngine || getNodeById(node?.id) || null;
	if ( !se ) return false;
	
	// check for multiple engines (v1.27+)
	if ( se && !info.multiURL ) {
		
		// check for arrays
		try {

			let folder = {
				type: "folder",
				children: []
			}

			JSON.parse(se.template).forEach( (url, index) => {

				// make sure not the same node
				if ( url === node.id ) return;
				
				// if url and not ID
				if ( isValidHttpUrl(url) ) {

					let tmp = {
						template: url,
						type: "temporarySearchEngine",
						title: "multisearch (" + index + ")",
						method: se.method,
						id: gen()
					}

					// parse encoding for multi-URLs
					let matches = /{encoding=(.*?)}/.exec(url);
		
					if ( matches && matches[1] )
						tmp.queryCharset = matches[1];

					folder.children.push(tmp);

				} else if ( findNode(userOptions.nodeTree, n => n.id === url )) {
					
					// copy nodes to prevent overwriting hidden attribute
					let n = JSON.parse(JSON.stringify(findNode(userOptions.nodeTree, n => n.id === url )));
					
					// include hidden engines in the multisearch
					if (userOptions.multisearchIncludeHidden )
						n.hidden = false;

					folder.children.push(n);
				} else {
					console.log('url invalid', url);
					return;
				}
			});
			
			notify({action: "addToHistory", searchTerms: searchTerms});

			// overwrite last multi-child
			lastSearchHandler(info.menuItemId, info.openMethod);

			console.log(folder);

			info.node = folder;

			folderSearch(info, false);

			return;
			
		} catch (error) {
		//	console.log(error);
		}
	}

	if ( !temporarySearchEngine && !info.multiURL ) 
		notify({action: "addToHistory", searchTerms: searchTerms});

	// must be invalid
	if ( !se.template) return false;

	// legacy fix
	se.queryCharset = se.queryCharset || "UTF-8";
	
	if ( se.searchRegex ) {
		try {
			runReplaceRegex(se.searchRegex, (r, s) => {
				searchTerms = searchTerms.replace(r, s);
			});

		} catch (error) {
			console.error("regex replace failed");
		}
	}

	var encodedSearchTerms = encodeCharset(searchTerms, se.queryCharset);

	var q = await replaceOpenSearchParams({template: se.template, searchterms: encodedSearchTerms.uri, url: tab.url, domain: domain});

	// set landing page for POST engines
	if ( 
		!searchTerms || // empty searches should go to the landing page also
		(typeof se.method !== 'undefined' && se.method === "POST") // post searches should go to the lander page
	) {
		
		if ( se.searchForm )
			q = se.searchForm;
		else {
			let url = new URL(se.template);
			q = url.origin + url.pathname;
		}
		
	}

	openWithMethod({
		openMethod: openMethod, 
		url: q, 
		openerTabId: openerTabId == -1 ? null : openerTabId // chrome pdf reader gives tab.id of -1
	}).then(onCreate, onError);
	
	function executeSearchCode(tabId) {
		if ( !se.searchCode ) return;

		executeUserScript({
			tabId: tabId, 
			code: 'searchTerms = "' + escapeDoubleQuotes(searchTerms) + '"; ' + se.searchCode,
			nodeId: node.id
		});
	}
	
	function onCreate(_tab) {

		if ( !_tab ) return;

		// if new window
		if (_tab.tabs) {
			self.folderWindowId = _tab.id;
			_tab = _tab.tabs[0];
			
			console.log('window created');
		}

		try {
			if ( !info.multiURL )
				addTabTerms(node, _tab.id, searchTerms);
		} catch (err) {
			console.log(err);
		}

		browser.tabs.onUpdated.addListener(async function listener(tabId, changeInfo, __tab) {
			
			if ( tabId !== _tab.id ) return;

			// prevent redirects - needs testing
			
			let landing_url = new URL(q);
			let current_url = new URL(__tab.url);
				
			if ( userOptions.ignoreSearchRedirects && current_url.hostname.replace("www.", "") !== landing_url.hostname.replace("www.", "")) return;

			// non-POST should wait to complete
			if (typeof se.method === 'undefined' || se.method !== "POST" || !searchTerms) {

				if ( changeInfo.status !== 'complete' ) return;

				browser.tabs.onUpdated.removeListener(listener);
				
				highlightSearchTermsInTab(__tab, searchTerms);
				executeSearchCode(_tab.id);

				return;
			}
			
			browser.tabs.onUpdated.removeListener(listener);

			await executeScripts(_tab.id, {files: ['/lib/browser-polyfill.min.js', '/opensearch.js', '/post.js']}, true);

			await browser.tabs.onUpdated.addListener(async function _listener(_tabId, _changeInfo, _tabInfo) {
					
				if ( _tabId !== _tab.id ) return;

				if ( _tabInfo.status !== 'complete' ) return;

				browser.tabs.onUpdated.removeListener(_listener);
				
				highlightSearchTermsInTab(_tabInfo, searchTerms);
				executeSearchCode(_tabId);
			});

			_executeScript({
				func: (se, s) => {
					window._SEARCHTERMS = s;
					post(se.template, se.params);
				},
				args: [JSON.parse(JSON.stringify(se)), escapeDoubleQuotes(searchTerms)],
				tabId: _tab.id
			});
		});
	}
	
	function onError(error) {
		console.log(`Error: ${error}`);
	}

}

function addTabTerms(node, tabId, s) {
	console.log('tabTerms add', node.title);
	self.tabTerms.unshift({id: node.id, folderId: node.parentId, tabId: tabId, searchTerms: s});
}

function removeTabTerms(tabId) {
	self.tabTerms = self.tabTerms.filter(t => t.tabId !== tabId);
}

function deactivateTabTerms(tabId) {
	
	for ( tt in self.tabTerms) {
		if ( tt.tabId === tabId ) {
			tt.deactivated = true;
		}
	}
}

function getTabTermsTab(id, s) {
	let t = self.tabTerms.find(_t => _t.id === id && _t.searchTerms === s && !_t.deactivated );
	return browser.tabs.get(t.tabId);
}

async function folderSearch(info, allowFolders) {

	let node = info.node;

	let messages = [];
	
	if ( ["openNewWindow", "openNewIncognitoWindow"].includes(info.openMethod) ) {
		
		let win = await browser.windows.create({
			url: "about:blank",
			incognito: info.openMethod === "openNewIncognitoWindow" ? true : false
		});
		
		info.tab = win.tabs[0];
		info.openMethod = "openCurrentTab";	

		// delay required in FF, else blank page
		await new Promise(r => setTimeout(r, 500));
	}

	// track index outside forEach to avoid incrementing on skipped nodes
	let index = 0;

	node.children.forEach( _node => {
		
		if ( _node.hidden) return;
		if ( _node.type === "separator" ) return;
		if ( _node.type === "folder" && !allowFolders ) return;

		let _info = Object.assign({}, info);
		
		_info.openMethod = index ? "openBackgroundTab" : _info.openMethod;
		_info.folder = index++ ? true : false;
		_info.menuItemId = _node.id;
		_info.searchTerms = info.selectionText || info.searchTerms; // contextMenu uses both, be careful
		_info.node = _node;

		if ( _node.type === "folder" && allowFolders )
			messages.push( async() => await folderSearch(_info) );
		else
			messages.push( async() => await openSearch(_info) );
	});

	async function runPromisesInSequence(promises) {
		for (let promise of promises)
			await promise();
		
		lastSearchHandler(node.id);
	}

	return runPromisesInSequence(messages);
}

function escapeDoubleQuotes(str) {
	if ( !str ) return str;
	return str.replace(/\\([\s\S])|(")/g,"\\$1$2");
}

function escapeBackticks(str) {
	if ( !str ) return str;
	return str.replace(/\\([\s\S])|(`)/g,"\\$1$2");
}

function highlightInjectScripts(tab) {
	return executeScripts(tab.id, {files: ["/lib/mark.es6.min.js", "/inject_highlight.js"], allFrames: true}, true);
}

async function highlightSearchTermsInTab(tab, searchTerms) {
	
	if ( !tab ) return;

	// wait on /inject.js 
	await waitOnInjection(tab.id);

	// inject highlighting
	await highlightInjectScripts(tab);

	// inject results navigation
	executeScripts(tab.id, {files: ["inject_resultsEngineNavigator.js"]}, true);

	if ( userOptions.sideBar.openOnResults ) {
		_executeScript({
			func: () => openSideBar({noSave: true, minimized: userOptions.sideBar.openOnResultsMinimized, openedOnSearchResults: true}),
			tabId: tab.id
		})
	}

	if ( !userOptions.highLight.enabled ) return;
	
	// show the page_action for highlighting
	// if ( browser.pageAction ) {
	// 	browser.pageAction.show(tab.id);
	// 	browser.pageAction.onClicked.addListener( tab => {
	// 		notify({action: "unmark"});
	// 		notify({action: "removeTabHighlighting", tabId: tab.id});
	// 		browser.pageAction.hide(tab.id);
	// 	});
	// }

	_executeScript({
		func: (s) => document.dispatchEvent(new CustomEvent("CS_markEvent", {detail: {type: "searchEngine", searchTerms: s}})),
		args: [escapeDoubleQuotes(searchTerms)],
		tabId: tab.id,
		allFrames: true
	});

	if ( userOptions.highLight.followDomain || userOptions.highLight.followExternalLinks ) {
		
		let url = new URL(tab.url);

		let obj = {tabId: tab.id, searchTerms: searchTerms, domain: url.hostname};
		
		if ( ! highlightTabs.find( ht => JSON.stringify(obj) === JSON.stringify(ht) ) )
			highlightTabs.push(obj);
	}
}

function getAllOpenTabs() {
	
	function onGot(tabs) { return tabs; }
	function onError(error) { console.log(`Error: ${error}`); }

	var querying = browser.tabs.query({});
	return querying.then(onGot, onError);
}

function encodeCharset(string, encoding) {

	// encodeCharset("ハードディスク", "SHIFT_JIS"); 

	try {
		
		if ( encoding.toLowerCase() === "none" )
			return {ascii: string, uri: string};
		
		if (encoding.toLowerCase() === 'utf-8') 
			return {ascii: string, uri: encodeURIComponent(string)};
		
		let uint8array = new Encoding.TextEncoder(encoding, { NONSTANDARD_allowLegacyEncoding: true }).encode(string);
		let uri_string = "", ascii_string = "";
		
		for (let uint8 of uint8array) {
			let c = String.fromCharCode(uint8);
			ascii_string += c;
			uri_string += (c.match(/[a-zA-Z0-9\-_.!~*'()]/) !== null) ? c : "%" + uint8.toString(16).toUpperCase();
		}

		return {ascii: ascii_string, uri: uri_string};
	} catch (error) {
		console.log(error.message);
		return {ascii: string, uri: string};
	}
}

function encodeCharsetBrowser(string, encoding) {

	try {
		
		if ( encoding.toLowerCase() === "none" )
			return {ascii: string, uri: string};
		
		if (encoding.toLowerCase() === 'utf-8') 
			return {ascii: string, uri: encodeURIComponent(string)};
		
		let uint8array = new TextEncoder(encoding, { NONSTANDARD_allowLegacyEncoding: true }).encode(string);
		let uri_string = "", ascii_string = "";
		
		for (let uint8 of uint8array) {
			let c = String.fromCharCode(uint8);
			ascii_string += c;
			uri_string += (c.match(/[a-zA-Z0-9\-_.!~*'()]/) !== null) ? c : "%" + uint8.toString(16).toUpperCase();
		}

		return {ascii: ascii_string, uri: uri_string};
	} catch (error) {
		console.log(error.message);
		return {ascii: string, uri: string};
	}
}

function resetPersist() {
// turn off if persist = false 
	userOptions.quickMenuTools.forEach( (tool,index) => { 
		if ( tool.persist && tool.persist === false )
			userOptions.quickMenuTools[index].on = false;
	});
}

function setIcon() {
	if ( browser.action ) // v3
		browser.action.setIcon({path: userOptions.searchBarIcon || 'icons/logo_notext.svg'});
	else if ( browser.browser_action ) // v2
		browser.action.setIcon({path: userOptions.searchBarIcon || 'icons/logo_notext.svg'});
}

async function checkForOneClickEngines() {

	// not FF 63+
	if ( !browser.search || !browser.search.get ) return -1;
	
	// don't add before nodeTree is populated
	if ( !Object.keys(userOptions.nodeTree).length ) {
		console.log('empty nodeTree - aborting one-click check');
		return -1;
	}

	let engines = await browser.search.get();

	let newEngineCount = 0;
	engines.forEach( engine => {
		let found = findNode(userOptions.nodeTree, node => node.title === engine.name && ( node.type === "searchEngine" || node.type === "oneClickSearchEngine") );
		
		if ( found ) return;

		if ( userOptions.autoImportFirefoxEngines ) {

			let node = {
				type: "oneClickSearchEngine",
				title: engine.name,
				icon: engine.favIconUrl || browser.runtime.getURL('icons/search.svg'),
				hidden: false,
				contexts: 32,
				id: gen()
			}

			console.log('adding One-Click engine ' + engine.name);
			userOptions.nodeTree.children.push(node);
		}
		
		newEngineCount++;
		
	});
	
	return newEngineCount;
}

// note: returns a promise to loadRemoteIcons
function dataToSearchEngine(data) {
	
	// useful when using page_action to trigger custom search iframe
	if (!data) return null;

	let favicon_href = data.favicon_href || "";

	let template = "";
	let params = [];
	
	// convert single object to array
	for (let k in data.params)
		params.push({name: k, value: data.params[k]});

	if (data.method === "GET" && data.query) {
		
		let param_str = data.query + "={searchTerms}";

		for (let i in data.params) {
			param_str+="&" + i + "=" + data.params[i];
		}
		// If the form.action already contains url parameters, use & not ?
		template = data.action + ((data.action.indexOf('?') === -1) ? "?":"&") + param_str;	
		
	} else {
		// POST form.template = form.action
		template = data.action;
		
		if (data.query)
			params.unshift({name: data.query, value: "{searchTerms}"});

	}
	
	// build search engine from form data
	let se = {
		"searchForm": data.origin, 
		"icon": data.favicon_href || data.origin + "/favicon.ico",
		"title": data.name || data.title,
		"order":findNodes(userOptions.nodeTree, n => n.type === "searchEngine").length, 
		"method": data.method, 
		"params": params, 
		"template": template, 
		"queryCharset": data.characterSet.toUpperCase(),
		"description": data.description,
		"id": gen()
	};

	return loadRemoteIcon({
		searchEngines: [se],
		timeout:5000
	});

}

function isAllowedURL(_url) {

	try {
		let url = new URL(_url);

		// test for pure hostname
		if ( userOptions.blockList.includes(url.hostname)) return false;

		for ( let pattern of userOptions.blockList) {

			// skip blank
			if ( !pattern.trim() ) continue;

			// skip disabled
			if ( /^!|^#/.test(pattern) ) continue

			// test for pure regex
			try {
				let regex = new RegExp(pattern);
				if ( regex.test(url.href)) {
					console.log(url.href + " matches " + pattern);
					return false;
				}
				continue;
			} catch( err ) {}
			
			// test for wildcards
			try {
				let regex = new RegExp(pattern.replace(/\*/g, "[^ ]*").replace(/\./g, "\\."));
				if ( regex.test(url.hostname) || regex.test(url.href)) {
					console.log(url.href + " matches " + pattern);
					return false;
				}
				continue;
			} catch (err) {}
		}
	} catch (err) { console.log('bad url for tab', _url, err)}

	return true;
}

async function executeScripts(tabId, options = {}, checkHasRun) {

	if ( options.allFrames ) {

		delete options.allFrames;

		return new Promise(async r => {
			let frames = await browser.webNavigation.getAllFrames({tabId: tabId});

			for ( let frame of frames ) {
				await executeScripts(tabId, Object.assign({}, options, {frameId: frame.frameId}), checkHasRun);
			}

			r();
		});
	}

	let blacklist = options.blacklist || [];

	let tab = await browser.tabs.get(tabId);

	if ( !isAllowedURL(tab.url) ) return false;

	if ( !await isTabScriptable(tabId, options.frameId || 0) ) return false;

	// do not run on extension pages
	if ( tab.url.startsWith(await browser.runtime.getURL("")) ) return false;

	// filter documents that can't attach menus
	let isHTML = await _executeScript({
		func: () => document && document.querySelector('html') ? true : false,
		tabId: tabId,
		frameId: options.frameId || 0,
		injectImmediately: true
	})

	if ( !isHTML ) return false;

	// filter popup windows 
	if ( self.popupWindows.includes(tab.windowId))
		blacklist = ['/inject_sidebar.js'];

	onFound = () => {}
	onError = err => {console.log(err)}

	const files = options.files;
	delete options.files;

	for ( const file of files ) {

		if ( blacklist.includes(file) ) continue;

		try {

			if ( checkHasRun ) {

				let check = await _executeScript({
					func: (file) => (typeof window.CS_HASRUN !== 'undefined' && window.CS_HASRUN[file]),
					args: [file],
					tabId: tabId,
					frameId: options.frameId || 0,
					injectImmediately: true
				})

				if ( check ) {
					debug('already injected', file, tabId, options.frameId || 0);
					continue;
				}
			}

			await _executeScript({
				file: file,
				tabId: tabId,
				frameId: options.frameId || 0,
				injectImmediately: true
			});

			debug('injected', file, tabId, options.frameId || 0);
			if ( checkHasRun ) {

				await _executeScript({
					func: (file) => { window.CS_HASRUN = window.CS_HASRUN || []; window.CS_HASRUN[file] = true;},
					args: [file],
					tabId: tabId,
					frameId: options.frameId || 0,
					injectImmediately: true	
				})

			}
		} catch (error) {
			debug(tabId, error);
		}
	}
}

async function injectContentScripts(tab, frameId = 0) {

	// skip frames without host permissions
	// checked again in executeScripts() but also skips CSS injection
	if ( !await isTabScriptable(tab.id, frameId || 0) ) return false;

	// inject into any frame
	// used with init_content.js to only inject when window receives focus
	await executeScripts(tab.id, {
		files: [
			"/utils.js", // for isTextBox
			"/nodes.js", // for shortcuts
			"/Shortcuts.js",
			"/inject.js",
			"/contexts.js",
			"/tools.js" // for shortcuts
		], frameId: frameId, runAt: "document_start"
	}, true);

	_insertCSS({tabId: tab.id, frameId: frameId, file: "/inject.css"});

	if ( frameId === 0 ) { /* top frames only */
		await executeScripts(tab.id, {
			files: [
				"/inject_addContextSearchEngine.js",
				"/iconUtils.js",
				"/searchEngineUtils.js"
			], runAt: "document_start"
		}, true);
	}

	(async() => {

		// open findbar on pageload if set
		if ( frameId === 0 && userOptions.highLight.findBar.startOpen) {
			await highlightInjectScripts(tab);
			let isOpen = await notify({action: "getFindBarOpenStatus"});
			if ( isOpen ) return;

			notify({action: "updateFindBar", options: userOptions.highLight.findBar.markOptions}, tab);
		}

		// open sidebar on pageload if set
		if ( frameId === 0 && ( userOptions.sideBar.startOpen || userOptions.sideBar.widget.enabled )) {
			await executeScripts(tab.id, {files: ["/dock.js", "resizeWidget.js", "/inject_sidebar.js"]}, true);

			if ( userOptions.sideBar.widget.enabled )
				notify({action: "makeOpeningTab"}, tab);

			if ( userOptions.sideBar.startOpen )
				notify({action: "openSideBar"}, tab);

		}
	})();
}

function waitOnInjection(tabId) {

	let interval;
	let timeout;
	const start = Date.now();

	const cleanup = () => {
		clearInterval(interval);
		clearTimeout(timeout);
	}

	return Promise.race([

		// timeout
		new Promise(r => {
			timeout = setTimeout(() => {
				cleanup();
				debug('waitOnInjection timeout', tabId);
				r(false);
			}, userOptions.waitOnInjectionTimeout);
		}),

		// interval test
		new Promise(r => {
			interval = setInterval(async () => {
				try {

					let result = await _executeScript({
						func: () => window.CS_HASRUN && window.CS_HASRUN['/inject.js'],
						tabId: tabId
					});

					if ( result ) {
						cleanup();
						debug(`waitOnInjection (tab ${tabId}) took ${Date.now() - start}ms`);
						r(true);
					}

				} catch ( error ) {
					cleanup();
					debug('waitOnInjection failed', tabId);
					r(false);
				}
			}, 250);
		})
	]);
}


// test code
async function scrapeBookmarkIcons() {
	let bms = await CSBookmarks.treeToFolders("root________");
	findNode(bms, n => {
		if ( n.type !== 'bookmark') return false;
		browser.bookmarks.get(n.id).then( bm => {
			bm = bm.shift();
			console.log(bm);
			fetchFavicon(bm.url);
		})
		
	});

	async function fetchFavicon(_url) {

		console.log(_url);

		try {

			let url = new URL(_url);
			console.log('fetching', url.origin);
			var response = await fetch(url.origin + "/favicon.ico");
			switch (response.status) {
				// status "OK"
				case 200:
					console.log(url.origin + "/favicon.ico found!");
					// var template = await response.text();

					// console.log(template);
					break;
				// status "Not Found"
				case 404:
					console.log('Not Found');
					break;
			}
		} catch ( error ) {}
	} 
}

function userInputCurrentTab(func, str) {

	let id = gen();

	browser.tabs.query({currentWindow: true, active: true}).then( async tabs => {

		let tab = tabs[0];

		if ( ! await isTabScriptable(tab.id) ) {
			tab = await browser.tabs.create({
				url: browser.runtime.getURL("blank.html")
			});
		}
		
		_executeScript({
			tabId: tab.id,
			func: (func, message, id, tabId) => {
					setTimeout(() => {
						let str = "";

						if ( func === "prompt")
							str = prompt(message);
						if ( func === "confirm")
							str = confirm(message);

						browser.runtime.sendMessage({output:str, id: id, tabId: tabId});
					}, 100);
				},
			args: [func, str, id, tabs[0] !== tab ? tab.id : -1 ]
		})
	});

	return new Promise(resolve => {
		browser.runtime.onMessage.addListener(function listener(result, sender) {

			if ( !result.id || result.id !== id ) return;

			browser.runtime.onMessage.removeListener(listener);

			if ( result.tabId !== -1 ) {
				browser.tabs.update(result.tabId, {active: false}).then(() => {
					browser.tabs.remove(result.tabId);
				});				
			}

  			resolve(result.output);
		});
	});
}

async function isTabScriptable(tabId, frameId = 0) {
	try {
		let result = await _executeScript({func: () => true, tabId: tabId, frameId: frameId, injectImmediately: true});
		return result ? true : false;
	} catch ( error ) {
		return false;
	}
}

promptCurrentTab = (str) => userInputCurrentTab("prompt", str);
confirmCurrentTab = (str) => userInputCurrentTab("confirm", str);

async function browserSaveAs(url) {
	if ( !await hasPermission("downloads") ) {
		let optionsTab = await notify({action: "openOptions", hashurl:"?permission=downloads#requestPermissions"});
		return;
	}

	return browser.downloads.download({url: url, saveAs: true});
}

async function executeUserScript(o) {

	if ( browser?.scripting?.executeScript ) { // v3
		let hasUserScriptsPermission = await hasPermission("userScripts");
		if ( !hasUserScriptsPermission ) {
			let optionsTab = await notify({action: "openOptions", hashurl:"?permission=userScripts#requestPermissions"});
			return;
		}

		// chrome catch missing userScripts permisison
		if ( hasUserScriptsPermission && !browser.userScripts ) {

			// alert the user
			let result = await _executeScript({
				tabId: o.tabId,
				func: (msg) => confirm(msg),
				args: [i18n("UserScriptsMessageChrome")]
			})

			// open the extension settings
			if ( result ) {
				browser.tabs.create({
					url: "chrome://extensions/?id=" + browser.runtime.id
				});
			}

			return;
		}

		// chrome
		if ( hasUserScriptsExecute()) {

			return browser.userScripts.execute({
				target: { tabId: o.tabId },
				world: "USER_SCRIPT",
				js: [{ code: o.code }]
			});

		} else { // firefox

			let id = o.nodeId + ( ("nativeAppResult" in o ) ? "_postscript" : "");

			debug('executeUserScript():firefox', id, self.searchTerms);
			
			return browser.scripting.executeScript({
				target: { tabId: o.tabId },
				func: (_id, _str, _result) => { 
					searchTerms = _str;
					result = _result;
					userScripts[_id](); 
				},
				args: [id, self.searchTerms, o.nativeAppResult || ""],
				world: "MAIN"
			});
		}
	} else { // v2
		return browser.tabs.executeScript(tabId, {
			code: code
		});
	}
}

function registerAllUserScripts() {

	// no permission
	if ( typeof browser.userScripts === 'undefined' ) return Promise.resolve(false);

	// better method (chrome)
	if ( hasUserScriptsExecute() ) return Promise.resolve(false);

	const js = [];

	traverseNodes(userOptions.nodeTree, n => {

		let searchCode = n.searchCode;

		if ( n.type === 'searchEngine') {
			let se = getNodeById(n.id);
			searchCode = se.searchCode;
		}

		if ( searchCode ) {
			let code = "userScripts['" + n.id + "'] = function() {\n" 
				+ searchCode 
				+ "\n};"

			js.push({code: code});
			debug('registering script for ' + n.title);
		}

		if ( n.postScript ) {
				let code = "userScripts['" + n.id + "_postscript'] = function() {\n" 
				+ n.postScript 
				+ "\n};";

			js.push({code: code});
			debug('registering script for ' + n.title);
		}
	});

	// register the script array, then check each script individually to catch errors
	return browser.userScripts.register([{
		id: 'userScripts',
		world: 'MAIN',
		matches: ["<all_urls>"],
		js: [{code: "const userScripts = {};"}]
	}]).then(() => {
		for ( j of js ) {
			browser.userScripts.register([{
				id: gen(),
				world: 'MAIN',
				matches: ["<all_urls>"],
				js: [j]
			}]).catch(error => {
				console.log("error registering a user script", error);
			});
		}
	});
}

function unregisterAllUserScripts() {

	// no permission
	if ( typeof browser.userScripts === 'undefined' ) return Promise.resolve(false);;

	// better method (chrome)
	if ( hasUserScriptsExecute() ) return Promise.resolve(false);;

	return browser.userScripts.unregister({});
}

function updateUserScripts() {
	return unregisterAllUserScripts()
		.then(() => registerAllUserScripts());
}

async function _insertCSS(o) {
	if ( browser?.scripting?.insertCSS ) {
		const insertOptions = {
			target: {
				tabId: o.tabId,
				frameIds: [o.frameId],
				allFrames: o.allFrames
			},
			files: [o.file],
			css: o.css,
			origin: "USER"
		}

		if ( !o.file ) delete insertOptions.files;
		if ( !o.css ) delete insertOptions.css;
		if ( !o.hasOwnProperty("allFrames") ) delete insertOptions.target.allFrames;
		if ( !o.hasOwnProperty("frameId") ) delete insertOptions.target.frameIds;

		return o.removeCSS 
			? browser.scripting.removeCSS(insertOptions)
			: browser.scripting.insertCSS(insertOptions);
	} else {
		const insertOptions = {
			file: o.file , 
			frameId: o.frameId, 
			code: o.css, 
			allFrames: o.allFrames,
			cssOrigin: "user"
		}

		if ( !o.file ) delete insertOptions.file;
		if ( !o.css ) delete insertOptions.code;
		if ( !o.hasOwnProperty("allFrames") ) delete insertOptions.allFrames;
		if ( !o.hasOwnProperty("frameId") ) delete insertOptions.frameId;

		return o.removeCSS
			? browser.tabs.removeCSS(o.tabId, insertOptions)
			: browser.tabs.insertCSS(o.tabId, insertOptions);
	}
}

async function _removeCSS(o) {
	o.removeCSS = true;
	return _insertCSS(o);
}
