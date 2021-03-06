/**
 * Created by songjian on 2016/9/22.
 */
var commonSourceServer = require("../commonSource");
var ipconfig = require("../runconfig");

var defaultBufferSize = 1024;
var receiveBufferSize = defaultBufferSize;
var receiveBuffer = new Buffer(defaultBufferSize);
var receiveOffset = 0;
var recentDate = new Date();

var net = require('net');

var fs = require('fs');

var RecentProcess = true;//确保一个进程
var lsSocket = new net.Socket();

var recentRequestStr;//记录当前的RequestStr，在发送时如果后台程序掉线，利用这里的记录值进行重发
var recentSN;//记录当前的SN，在发送时如果后台程序掉线，利用这里的记录值进行重发
var recentThirdSessionId = "";//登陆后，后台返回的sessionid，每次下命令时，都要包含这个id。
var loginFlag = false;//当前操作是否为登陆操作。

var flagConnect = 0;

var lsSessionFile = "lsSessionFile";

fs.readFile(lsSessionFile, function (err, bytesRead) {
    if (err) {
        commonSourceServer.errorLogFile.error("ls_index.js fs.readFile lsSessionFile err :" + err);
    } else {

        recentThirdSessionId = bytesRead.toString('utf8', 0);
        //console.log("recentThirdSessionId:"+recentThirdSessionId);
    }
});


/**
 * 生成 SN 标记，返回 SN 的值
 **/
var SNMax = 0;
function getSN() {
    SNMax++;
    if (SNMax == 65534) {
        SNMax = 0;
    }
    return SNMax;
}

/**
 * 函数名：start
 * 功能：ls的客户端，用于向后台 ls 服务端发送请求信息
 * 目标源：高英健程序
 */
function start() {

    function connectServer() {
        var x = lsSocket.connect(ipconfig.lsPORT, ipconfig.lsHOST);
    }

    connectServer();

    lsSocket.on('error', function (error) {
        if (flagConnect == 0) {
            commonSourceServer.errorLogFile.error('lsSocket Error :' + error.toString());
            var connectError = {
                "TYPE":"605",
                "content" : "与检测后台通信失败！"
            }
            var ErrorArray = [];
            ErrorArray.push(connectError);
            commonSourceServer.gjReceivePushArray.push(ErrorArray);
            commonSourceServer.EventEmitter.emit("receiveGJPushData");
            flagConnect = 1;
            console.log('lsSocket connection closed on ' + recentDate);
        }
        setTimeout(function(){
            connectServer();
        },5000)
    });

    lsSocket.on('close', function () {

        //console.log('lsSocket connection closed on ' + recentDate);

    });

    lsSocket.on('connect', function () {
        console.log('[lsSocket] connect Ok.');
        flagConnect = 0;
        commonSourceServer.EventEmitter.on("sendLSRequest", function () {
            if (!!commonSourceServer.lsStrArray[0]) {
                //console.log("dbStrArray :"+commonSourceServer.dbStrArray[0]);
                //console.log("count : "+RecentProcess);
                if (RecentProcess) {
                    //console.log(recentDate+':'+"dbStrArray :"+commonSourceServer.dbStrArray[0]);
                    /**
                     * 将请求信息重新做包发送给后台
                     **/
                    var RequestStr = commonSourceServer.lsStrArray.shift();
                    //console.log(recentDate+':'+"RequestStr :"+RequestStr);
                    var SN = getSN();
                    recentRequestStr = RequestStr;
                    recentSN = SN;
                    commonSourceServer.lsRequestSN.push(SN);
                    sendData(RequestStr, SN);
                    RecentProcess = false;
                }
            } else {
                //console.log('[else RecentProcess]:' + RecentProcess);
            }
        });
    });
    lsSocket.on('data', function (data) {
        try {
            bufferData(data);
        } catch (err) {
            commonSourceServer.errorLogFile.error("ls_index.js bufferData function err :" + err);
        }
    });
}

/**
 * 函数名：sendData
 * 功能 ：将前台请求信息传送给后台 ls 服务端
 * 参数 ：
 *   RequestStr ：前台请求信息
 *   SN ：向后台发送请求包的 SN 标识，暂时没用
 */
function sendData(RequestStr, SN) {
    commonSourceServer.requestLogFile.info("[ls_index sendData]client send Data to LS Server:" + RequestStr);
    //自动添加登陆会话id
    if (!loginFlag) {//所有非登陆操作都要添加登陆会话id
        var tmpLen = Buffer.byteLength(RequestStr);
        var tmpBuffer = new Buffer(tmpLen);
        //写入查询体
        tmpBuffer.write(RequestStr, 0);
        var tmpIndex = tmpBuffer.readUInt16BE(0);
        var tmpRequestStr = tmpBuffer.toString('utf8', 2);
        var requestObj = JSON.parse(tmpRequestStr);
        requestObj["third_session_id"] = recentThirdSessionId;
        tmpRequestStr = JSON.stringify(requestObj);
        tmpBuffer = new Buffer(Buffer.byteLength(tmpRequestStr) + 2);
        //写入2个字节接口编码
        tmpBuffer.writeUInt16BE(tmpIndex, 0);
        //写入查询体
        tmpBuffer.write(tmpRequestStr, 2);
        RequestStr = tmpBuffer.toString('utf8', 0);
    }
    var len = Buffer.byteLength(RequestStr);

    var sendLsBuffer = new Buffer(len + 8);
    //console.log("len of send data : " + len);

    //写入2个字节特征码
    sendLsBuffer.writeUInt16BE(65534, 0);//0xfffe

    //写入2个字节编号
    sendLsBuffer.writeUInt16BE(SN, 2);

    //写入4个字节表示本次包长
    sendLsBuffer.writeUInt32BE(len, 4);

    //写入数据
    try {
        sendLsBuffer.write(RequestStr, 8);
        lsSocket.write(sendLsBuffer);
    } catch (err) {
        commonSourceServer.errorLogFile.error("ls_index.js sendData function sendDbBuffer.write(RequestStr, 8) err :" + err);
    }

}

/**
 * 函数名：bufferData
 * 功能：用于接收后台返回请求的数据包
 * 参数：
 *   data ：返回的数据包信息
 */
function bufferData(data) {
    //如果当前数据包data的长度大于可用的receiveBuffer，new一个新的receiveData，之后进行旧有数据的拷贝。
    while (data.length > receiveBufferSize - receiveOffset) {
        var dataNeedBufferSize = data.length - (receiveBufferSize - receiveOffset);//本次data需要的buffer大小为本data长度减去receiveBuffer中空闲buffer的大小。
        //如果需要的buffer大小（dataNeedBufferSize）大于defaultBufferSize，则增加dataNeedBufferSize，否则增加dataNeedBufferSize，避免多个小包一起过来，导致多次扩大buffer。
        receiveBufferSize += dataNeedBufferSize > defaultBufferSize ? dataNeedBufferSize : defaultBufferSize;
        //console.log("receiveBufferSize : " + receiveBufferSize);
        var tmpReceiveBuffer = new Buffer(receiveBufferSize);
        receiveBuffer.copy(tmpReceiveBuffer);
        receiveBuffer = tmpReceiveBuffer;
    }

    //将当前数据包data拷贝进receiveBuffer，并修改偏移量receiveOffset
    data.copy(receiveBuffer, receiveOffset);
    receiveOffset += data.length;
    //console.log("receiveOffset : " + receiveOffset);

    while (receiveOffset > 8) {//已收数据超过包头大小，开始处理数据
        // console.log("0xfffe : " + receiveBuffer.readUInt16BE(0));
        if (receiveBuffer.readUInt16BE(0) == 65534) {
            var SN = receiveBuffer.readUInt16BE(2);
            //console.log("SN : "+SN);
            var len = receiveBuffer.readUInt32BE(4);
            // console.log("len : " + len);
            if (len <= receiveOffset - 8) {//本条信息已经接收完成
                //根据len取出本次要处理的数据到dealDataBuffer，然后交由dealReceiveData函数处理
                var dealDataBuffer = new Buffer(len);
                receiveBuffer.copy(dealDataBuffer, 0, 8, 8 + len);
                dealReceiveDataSJ(dealDataBuffer, SN);
                //计算出剩余的buffer的大小，从receiveBuffer中拷贝出剩余数据到leftReceiveBuffer，再将leftReceiveBuffer重新赋给receiveBuffer。
                var leftBufferSize = receiveOffset - (8 + len);
                var leftReceiveBuffer = new Buffer(leftBufferSize);
                receiveBufferSize = leftBufferSize;
                receiveBuffer.copy(leftReceiveBuffer, 0, 8 + len, receiveOffset);
                receiveBuffer = leftReceiveBuffer;
                receiveOffset -= (8 + len);
            }
            else {//没接完，跳出去，进行下一次data事件的监听
                break;
            }
        }
        else {//报文异常，执行初始化，退出
            receiveBufferSize = defaultBufferSize;
            receiveBuffer = new Buffer(receiveBufferSize);
            receiveOffset = 0;
        }
    }
}

/**
 * 函数名：dealReceiveDataSJ
 * 功能：用于处理所接收的数据包，在此处控制单进程
 * 参数 ：
 *   dealDataBuffer ：数据包信息
 */
function dealReceiveDataSJ(dealDataBuffer) {

    var receiveDataString = dealDataBuffer.toString('utf8', 0);
    commonSourceServer.responseLogFile.info("LS Server response data :" + receiveDataString);
    // String 转换成 JSON
    var receiveDataJSON;
    try {
        receiveDataJSON = JSON.parse(receiveDataString);
    } catch (err) {
        commonSourceServer.errorLogFile.error("ls_index.js dealReceiveData function receiveDataJSON = JSON.parse(receiveDataString) err :" + err);
    }
    if ((receiveDataJSON["value"] == 0 && receiveDataJSON["desc"] == 2) || receiveDataJSON["code"] == 0) {//提示用户未登陆，需要重新登陆
        //  console.log("提示用户未登陆，需要重新登陆");
        var requestObj = {username: "user", password: "pwd"};//登陆的请求体
        var requestStr = JSON.stringify(requestObj);
        var interfaceIndex = 1;//接口编码
        var sqlLen = Buffer.byteLength(requestStr);
        var sqlBuffer = new Buffer(sqlLen + 2);
        //写入2个字节接口编码
        sqlBuffer.writeUInt16BE(interfaceIndex, 0);
        //写入查询体
        sqlBuffer.write(requestStr, 2);
        var sendStr = sqlBuffer.toString('utf8', 0);
        loginFlag = true;
        sendData(sendStr, recentSN);
    } else if (loginFlag && receiveDataJSON.value == 1) {//重新登陆完毕，再次发送
        //  console.log("重新登陆完毕，再次发送");
        recentThirdSessionId = receiveDataJSON["third_session_id"];
        fs.writeFile(lsSessionFile, recentThirdSessionId, function (err) {
            if (err) {
                commonSourceServer.errorLogFile.error("ls_index.js dealReceiveData function fs.writeFile(lsSessionFile, recentThirdSessionId) err :" + err);
            } else {
                commonSourceServer.infoLogFile.info("Export to lsSessionFile Success!");
            }
        });

        loginFlag = false;
        sendData(recentRequestStr, recentSN);//再次发送
    } else {
        console.log("receiveDataJSON:"+JSON.stringify(receiveDataJSON));
        commonSourceServer.lsReceiveStrArray.push(receiveDataJSON);
        RecentProcess = true;
        commonSourceServer.EventEmitter.emit("receiveLSData");
        commonSourceServer.EventEmitter.emit("sendLSRequest");
    }
}

exports.lsClientStart = start;