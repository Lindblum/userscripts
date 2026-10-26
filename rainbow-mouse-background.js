// ==UserScript==
// @author      Lindblum
// @name        Rainbow Mouse Move Background
// @namespace   https://github.com/lindblum/userscripts
// @version     0.1
// @description Experiment to change background color as you move your mouse
// @include     http://*
// @copyright   2026, Lindblum
// ==/UserScript==

console.log("Rainbow Mouse Move Background started");

window.TOGGLE = true;

function contains(array, value){
    for(i=0; i<array.length; i++)
        if(array[i]==value)
            return true;
    return false;
}//contains

function phaseColor(phase, whiteness){
    if(!whiteness) whiteness = 0;
	var g = (Math.cos(phase+Math.PI*(0/3+1/6))+1)/2;
	var r = (Math.cos(phase+Math.PI*(2/3+1/6))+1)/2;
	var b = (Math.cos(phase+Math.PI*(4/3+1/6))+1)/2;
//    var rgb = hsvToRgb(phase, 1, 1);
    if(whiteness>=0){
        r += (1-r)*whiteness;   g += (1-g)*whiteness;   b += (1-b)*whiteness;
    }else{
        r += r*whiteness;   g += g*whiteness;   b += b*whiteness;
    }
	r = Math.floor(r*255);	g = Math.floor(g*255);	b = Math.floor(b*255);
	return "rgb("+r+","+g+","+b+")";
}//phaseColor

function applyStyle(style, id){
    if(!id) id = "cssScripted";
	var dom = document.getElementById(id);
    if(!dom){ dom = document.createElement("style"); dom.setAttribute("id",id); document.head.appendChild(dom);}
	dom.innerHTML = style;
}//applyStyle

window.onmousemove = function(){
	if(!TOGGLE)	return;
	var xRatio = window.event.clientX / window.innerWidth;
	var yRatio = window.event.clientY / window.innerHeight;
	var phase = (xRatio*2-1)*Math.PI;
    var whiteness  = 1-2*yRatio;//yRatio<.5 ? 1-2*yRatio : 2*yRatio-1;
    var whiteness2 = -.5*(whiteness+(whiteness>=0 ? 1 : -1));
//    var thresh = .5;
//    if(-thresh<=whiteness2 && whiteness2<0) whiteness2 = -thresh;
//    else if(0<=whiteness2 && whiteness2<=thresh) whiteness2 = thresh;
    var backColor = phaseColor(phase, whiteness);
    var foreColor = phaseColor(phase+Math.PI,-whiteness);
    var linkColor = phaseColor(phase+Math.PI*7/6,-.8*whiteness);
    var strStyle = "";
/*
    if(TAG_CLASS_TABLE)    for(r=0; r<TAG_CLASS_TABLE.length; r++){
        var record = TAG_CLASS_TABLE[r];
        strStyle += record.tagName+"{background:"+backColor+"; color:"+foreColor+"} \n";
        for(c=0; c<record.classNames.length; c)
            strStyle += record.tagName+"."+record.classNames[c]+"{background:"+backColor+"; color:"+foreColor+"} \n";
    }
/*/
	var csvTagNames = "body,table,td,hr,div,span,blockquote,cite,code,pre,em,strong,dfn,p,h1,h2,h3,h4,h5,h6,li,b,i,font";
    strStyle += csvTagNames+"{background:"+backColor+"; color:"+foreColor+"} \n";
//*/
    strStyle += "a{color:"+linkColor+"} \n";
	applyStyle(strStyle);
};//onmousemove
//TODO: Do not set onclick, append it
window.onclick = function(){ TOGGLE = !TOGGLE; };//onclick

/*
function init(){
    var tagNames = "body,table,td,div,span,blockquote,code,p,h1,h2,h3,h4,h5,h6,b,i,font".split(",");
    window.TAG_CLASS_TABLE = [];
    for(t=0; t<tagNames.length; t++){
        var record = [];
        record.tagName = tagNames[t];
        record.classNames = [];
        var doms = document.getElementsByTagName(record.tagName);
console.log(record.tagName+"x"+doms.length)
        for(i=0; i<doms.length; i++){
            doms[i].removeAttribute("color"); //Remove color declarations
            var className = doms[i].getAttribute("class");
console.log(i +" "+className);
            if(className && !contains(record.classNames, className))
                record.classNames.push(className); //Don't remove styles, just register them so we can override color
        }
        TAG_CLASS_TABLE.push(record);
    }
}//init

init();
//*/

console.log("Rainbow Mouse Move Background finished");
