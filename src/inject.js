// unique object to reference globally
var quickMenuObject = { 
	keyDownTimer: 0,
	mouseDownTimer: null,
	mouseCoords: {x:0, y:0},
	screenCoords: {x:0, y:0},
	mouseCoordsInit: {x:0, y:0},
	mouseLastClickTime: 0,
	lastSelectTime: 0,
	lastSelectText:"",
	locked: false,
	searchTerms: "",
	searchTermsObject:{},
	disabled: false,
	mouseDownTargetIsTextBox: false,
	mouseLastContextMenuTime:0,
	contexts: []
};

var userOptions = {};
var killswitch = false; // global switch for disabling injected functions on the fly

window.suspendSelectionChange = false;

browser.runtime.sendMessage({action: "getUserOptions"}).then( uo => userOptions = uo);

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {

	if ( message.userOptions ) userOptions = message.userOptions;

	switch (message.action) {
		case "updateSearchTerms":

			quickMenuObject.searchTerms = message.searchTerms;

			// track the last selection with value
			quickMenuObject.lastSelectText = message.searchTerms || quickMenuObject.lastSelectText

			// send event to OpenAsLink tile to enable/disable
			document.dispatchEvent(new CustomEvent('updatesearchterms'));

			browser.runtime.sendMessage({
				action: "updateQuickMenuObject", 
				quickMenuObject: quickMenuObject
			});
			break;

		case "updateQuickMenuObject":

			quickMenuObject = Object.assign(quickMenuObject, { 
				keyDownTimer: quickMenuObject.keyDownTimer,
				mouseDownTimer: quickMenuObject.mouseDownTimer,
				mouseDownHoldTimer: quickMenuObject.mouseDownHoldTimer,
				mouseCoords: quickMenuObject.mouseCoords,
				screenCoords: quickMenuObject.screenCoords,
				mouseCoordsInit: message.quickMenuObject.mouseCoordsInit,
				mouseLastClickTime: Math.max(message.quickMenuObject.mouseLastClickTime, quickMenuObject.mouseLastClickTime),
				lastSelectTime: Math.max(message.quickMenuObject.lastSelectTime, quickMenuObject.lastSelectTime),
				lastSelectText: message.quickMenuObject.lastSelectText,
				locked: message.quickMenuObject.locked,
				searchTerms: message.quickMenuObject.searchTerms,
				searchTermsObject: message.quickMenuObject.searchTermsObject,
				disabled: message.quickMenuObject.disabled,
				mouseDownTargetIsTextBox: message.quickMenuObject.mouseDownTargetIsTextBox,
				mouseLastContextMenuTime:Math.max(message.quickMenuObject.mouseLastContextMenuTime, quickMenuObject.mouseLastContextMenuTime),
				contexts:message.quickMenuObject.contexts
			});

			break;

		case "showNotification":
			showNotification(message);
			break;

		case "copyRaw":
			return copyRaw(message.autoCopy);
			break;
	}
});

function getRawSelectedText(el) {
	if (el && typeof el.selectionStart !== 'undefined') {
		let start = el.selectionStart;
		let finish = el.selectionEnd;
		return el.value.substring(start, finish);
	} else
		return window.getSelection().toString().trim();

}

function getSelectedText(el) {
	return getRawSelectedText(el).trim();
}

function getContexts(el, e) {

	let co = getContextsObject(el, e);

	let c = [];
	for ( let key in co ) {
		if ( co[key] ) c.push(key);
	}

	if ( co.linkText && getLinkMethod(e) === 'text' && !c.includes("selection") ) c.push("selection");

	if ( c.length > 2) c = c.filter(_c => _c !== "frame" );
	if ( c.length > 1) c = c.filter(_c => _c !== "page" );

	return c;
}

function getContextsObject(el, e) {
	let o = {};
	["audio", "frame", "image", "link", "page", "selection", "video"].forEach(c => o[c] = null);

	if ( !el ) return o;

	o['image'] = getImage(el);
	if ( el instanceof HTMLAudioElement ) o['audio'] = el.src;
	if ( el instanceof HTMLVideoElement ) o['video'] = el.src;

	if ( el.closest && el.closest('a')) {
		o['link'] = el.closest('a').href;
		o['linkText'] = el.closest('a').innerText;
	}

	// replace thumbnails with source
	// if ( false && o['link'] && isURLImage(o['link']) ) {
	// 	console.log('thumbnail found');
	// 	o['image'] = o['link'];
	// }
	
	o['selection'] = getSelectedText(el);

	if ( el.nodeName === 'IFRAME' || ( el.ownerDocument && el.ownerDocument.defaultView != top ) ) o['frame'] = window.location.href;

	o['page'] = window.location.href;
	
	return o;
}

// update searchTerms when selecting text and quickMenuObject.locked = true
document.addEventListener("selectionchange", e => {

	if ( window.suspendSelectionChange ) return;

	// debouncer is causing issues on double-click selection with qm ( empty terms )
	if ( isTextBox(document.activeElement) ) return false;

	// reset before the debounce
	quickMenuObject.lastSelectTime = Date.now();

	debounce(() => {

		if ( window.suspendSelectionChange ) return;

		let searchTerms = window.getSelection().toString().trim();

		// if an opener method timer is running, skip
		if ( quickMenuObject.mouseDownTimer && !searchTerms ) return;

	//	quickMenuObject.lastSelectTime = Date.now();
		if ( searchTerms ) quickMenuObject.lastSelectText = searchTerms;

		quickMenuObject.searchTerms = searchTerms;
		
		browser.runtime.sendMessage({action: "updateSearchTerms", searchTerms: searchTerms, searchTermsObject: getContextsObject(e.target, e)});
		browser.runtime.sendMessage({action: 'updateContextMenu', searchTerms: searchTerms, currentContexts: getContexts(e.target, e), ctrlKey:e.ctrlKey});

	}, 250, "selectionchangedebouncer");
});

document.addEventListener('mouseup', e => {
	// left-button only
	if ( e.button !== 0 ) return;

	if ( !isTextBox(document.activeElement) ) return false;
	
	let searchTerms = getSelectedText(e.target);

	if (searchTerms) {
		quickMenuObject.searchTerms = searchTerms;
		browser.runtime.sendMessage({action: "updateSearchTerms", searchTerms: searchTerms, searchTermsObject: getContextsObject(e.target, e), input:true});
		browser.runtime.sendMessage({action: 'updateContextMenu', searchTerms: searchTerms, currentContexts: getContexts(e.target, e), ctrlKey:e.ctrlKey});
	}

})
// selectionchange handler for input nodes
// for (let el of document.querySelectorAll("input, textarea, [contenteditable='true']")) {
// 	el.addEventListener('mouseup', e => {

// 		// left-button only
// 		if ( e.button !== 0 ) return;

// 		if ( !isTextBox(e.target) ) return false;
		
// 		let searchTerms = getSelectedText(e.target);

// 		if (searchTerms) {
// 			quickMenuObject.searchTerms = searchTerms;
// 			browser.runtime.sendMessage({action: "updateSearchTerms", searchTerms: searchTerms, searchTermsObject: getContextsObject(e.target, e), input:true});
// 			browser.runtime.sendMessage({action: 'updateContextMenu', searchTerms: searchTerms, currentContexts: getContexts(e.target, e), ctrlKey:e.ctrlKey});
// 		}

// 	});
// }

// Relabel context menu root on mousedown to fire before oncontextmenu
window.addEventListener('mousedown', async e => {

	if ( e.button !== 2 ) return false;

	// check for widgets and cancel
	let csw = document.getElementById("contextsearch-widgets");
	if ( csw && csw.contains(e.target) ) return;

	let searchTerms = getSelectedText(e.target) || linkOrImage(e.target, e) || "";

	if ( !searchTerms && userOptions.contextMenuUseInnerText ) {
		searchTerms = e.target.innerText.trim();
	}
	
	browser.runtime.sendMessage({action: "updateSearchTerms", searchTerms: searchTerms, searchTermsObject: getContextsObject(e.target, e)});
	browser.runtime.sendMessage({action: 'updateContextMenu', searchTerms: searchTerms, currentContexts: getContexts(e.target), linkMethod:getLinkMethod(e), ctrlKey:e.ctrlKey});
});

function linkOrImage(el, e) {
	
	let link = userOptions.quickMenuOnLinks ? getLink(el, e) : "";
	let img = userOptions.quickMenuOnImages ? getImage(el, e) : "";

	if ( e && e.ctrlKey && link && img /* && userOptions.toggleLinksAndImagesWithCtrl */) {
		console.log('found link and image - using link ( CTRL )');
		return link;
	}

	if ( img ) return img;
	
	if ( link ) return link;

	if ( el instanceof HTMLVideoElement && userOptions.quickMenuOnVideos )
		return el.currentSrc || el.src;

	if ( el instanceof HTMLAudioElement && userOptions.quickMenuOnAudios ) {
		return el.currentSrc || el.src;
	}
	
	return false;	
}

// https://stackoverflow.com/a/1045012
function offset(elem) {
    if(!elem) elem = this;

    var x = elem.offsetLeft;
    var y = elem.offsetTop;

    while (elem = elem.offsetParent) {
        x += elem.offsetLeft;
        y += elem.offsetTop;
    }

    return { left: x, top: y };
}

function getLinkText(el) {

	if ( !el.closest ) return false;

	let a = el.closest('a');
	
	if ( !a ) return "";

	return a.innerText;
}

function getLinkMethod(e) {
	let method = userOptions.contextMenuSearchLinksAs;
	
	if ( e && e.ctrlKey ) return method === 'url' ? 'text' : 'url';
	else return method;
}

function getLink(el, e) {

	if ( !el.closest ) return false;

	let a = el.closest('a');
	
	if ( !a ) return "";
	
	return getLinkMethod(e) === 'url' ? a.href || a.innerText : a.innerText || a.href;
}

function getImage(el, e) {

	if ( !el.closest ) return false;
	
	if ( el.innerText ) return false;
	
	if ( el.tagName === 'IMG' ) return el.src;
	
	let style = window.getComputedStyle(el, false);
	
	let backgroundImage = style.backgroundImage;

	if ( ! /^url\(/.test(backgroundImage) ) return false;

	return backgroundImage.slice(4, -1).replace(/"/g, "")
}

function showNotification(message) {

	let msg = message.msg;

	let id = "CS_notification" + btoa(msg).substr(0,8);

	let n = document.getElementById(id) || document.createElement('notification');
	n.id = id;
	n.className = 'CS_notification';
	n.innerHTML = null;
	
	let img = new Image();
	img.src = browser.runtime.getURL('icons/logo_notext.svg');
	
	let cb = new Image();
	cb.src = browser.runtime.getURL('icons/crossmark.svg');
	cb.style = 'cursor:pointer;height:16px;position:absolute;right:10px;top: 50%;transform: translate(0, -50%);margin:0';
	cb.onclick = close;
	
	let content = document.createElement('div');
	content.className = 'content';
	content.innerText = msg;
	
	[img, content, cb].forEach(el => n.appendChild(el));

	n.style.opacity = 0;
	document.body.appendChild(n);
	n.getBoundingClientRect();
	n.style.opacity = 1;
	n.getBoundingClientRect();

	close = () => {
		runAtTransitionEnd(n, ['opacity'], () => {
			document.body.removeChild(n);
			delete n;
		});
		
		n.style.opacity = 0;
	}

	if ( !message.sticky ) setTimeout(close, 3000);
	
	n.onclick = function() {
		document.body.removeChild(n);
		delete n;
	}

	return n;
}

function checkContextMenuEventOrderNotification() {
	let n = showNotification({msg:"", sticky:true});

	let yes = document.createElement('a');
	yes.innerText = i18n('yes');
	yes.href = "#";

	let no = document.createElement('a');
	no.innerText = i18n('no');
	no.href="#";

	let content = n.querySelector('.content');
	content.innerText = i18n('checkContextMenuOrderNotification');
	n.appendChild(yes);
	n.appendChild(document.createTextNode(" / "));
	n.appendChild(no);

	no.onclick = function() {
		userOptions.checkContextMenuEventOrder = false;
		browser.runtime.sendMessage({action: "saveUserOptions", userOptions: userOptions, source: "checkContextMenuEventOrderNo"});
	}

	yes.onclick = function() {
		userOptions.checkContextMenuEventOrder = false;
		userOptions.quickMenuMoveContextMenuMethod = "dblclick";
		browser.runtime.sendMessage({action: "saveUserOptions", userOptions: userOptions, source: "checkContextMenuEventOrderYes"});
	}

}

// set zoom attribute to be used for scaling objects
function setZoomProperty() {
	let el = getShadowRoot().host || document.documentElement;
	el.style.setProperty('--cs-zoom', window.devicePixelRatio);
	el.style.setProperty('--cs-scale', 'calc( 1 / var(--cs-zoom,1) * var(--cs-custom-scale,1))');
}

document.addEventListener('zoom', setZoomProperty);

// apply global user styles for /^[\.|#]CS_/ matches in userStyles
browser.runtime.sendMessage({action: "addUserStyles", global: true });

// menuless hotkey
function checkForNodeHotkeys(e) {

	if ( 
		!userOptions.allowHotkeysWithoutMenu ||
		isTextBox(e.target)
	) return false;

	let searchTerms = getSearchTermsForHotkeys(e);

	if ( !searchTerms ) return false;
	
	let node = Shortcut.getNodeFromEvent(e);
	if ( !node ) return false;

	browser.runtime.sendMessage({
		action: "search", 
		info: {
			node: node,
			menuItemId: node.id,
			selectionText: searchTerms,
			openMethod: userOptions.quickMenuSearchHotkeys
		}
	});
}

function getSearchTermsForHotkeys(e) {
	let el = document.elementFromPoint(quickMenuObject.mouseCoords.x, quickMenuObject.mouseCoords.y);

	let img =  userOptions.allowHotkeysOnImages ? getImage(el) : null;
	let link = userOptions.allowHotkeysOnLinks ? getLink(el) : null;
	let page = userOptions.allowHotkeysOnPage ? window.location.href : null;

	if ( el instanceof HTMLAudioElement || el instanceof HTMLVideoElement ) 
		link = el.currentSrc || el.src;

	return getSelectedText(e.target) || img || link || page || "";
}

function createShadowRoot() {

	if ( typeof document.documentElement.shadowRoot === 'undefined' ) {
		document.body.getElementById = (id) => document.querySelector('#' + id);
		return;
	}

	if ( document.querySelector('contextsearch-widgets')) return;

	let div = document.createElement('contextsearch-widgets');
	div.id = "contextsearch-widgets";
	document.documentElement.appendChild(div);
	let shadow = div.attachShadow({mode: 'open'})
		.innerHTML = `
      <style>
        :host { all: initial !important; }
      </style>`;
}

function getShadowRoot() {

	let div = document.querySelector('contextsearch-widgets');

	if ( div && div.shadowRoot ) return div.shadowRoot;
	else return document.body || null;
}

// track mouse position
document.addEventListener("mousemove", e => {
	quickMenuObject.mouseCoords = {x: e.clientX, y: e.clientY};
	quickMenuObject.screenCoords = {x: e.screenX, y: e.screenY};

	screenCoords = {x: e.screenX, y: e.screenY};
}, {capture: true});

document.addEventListener('keydown', e => {
	if ( e.key === "Escape" ) {

		killswitch = true;

		// disable repeatsearch
		(() => {
			let tool = userOptions.quickMenuTools.find( _tool => _tool.name === "repeatsearch" );

			if ( tool && tool.on ) {
				tool.on === false;
				saveUserOptions();
			}
		})();
	}
});

// {

// 	document.addEventListener('keydown', e => {

// 		if ( !userOptions.developerMode ) return;
		
// 		if ( e.key === "s" && e.ctrlKey && e.altKey) {
// 			let f = document.createElement('iframe');
// 			f.setAttribute('allowtransparency', true);
// 			f.style="border:none;position:fixed;width:100vw;height:100vh;z-index:999;top:0;bottom:0;left:0;right:0;transform:scale(calc(1.5/var(--cs-zoom)))";
// 			f.src = browser.runtime.getURL('/speedDial.html?id=');

// 			getShadowRoot().appendChild(f);

// 			window.addEventListener('message', e => {
// 				if ( e.data.action && e.data.action === "close") {
// 					f.parentNode.removeChild(f);
// 				}
// 			});
// 		}
// 	});
// }

document.addEventListener("fullscreenchange", e => {
	let div = document.querySelector('contextsearch-widgets');
	if ( div ) div.style.display = document.fullscreen ? 'none' : null;
	else {
		let sb = getSideBar ? getSideBar() : null;
		let ot = getOpeningTab ? getOpeningTab() : null;
		let nb = getNavBar ? getNavBar() : null;
		let fb = getFindBar ? getFindBar() : null;

		[sb, ot, nb, fb].forEach( el => { 
	  		if ( el ) el.classList.toggle('CS_hide', document.fullscreen);
	  	});

	}
});

createShadowRoot();
setZoomProperty();
Shortcut.addShortcutListener();

browser.runtime.sendMessage({action: "injectComplete"});
