/*
 * This script parses a MIDI file and writes the events to a json file.
 */

var headerChunk = "MThd";
var trackChunk = "MTrk";
var tempTrackName = "";
// tempo is represented as microseconds per quarter note
// this is 120bpm, which is the default for MIDI with unspecified tempo
var tempo = 500000.0;
var overrideTempoBPM = 0.0;
var overrideTempo = 0.0;
var division = 0;
var outputDict = {};
var runningStatus = null;
var fs = require('fs');
var bytes;
var byteIndex = 0;

/*
 * Convert a Buffer into a number, assuming it's using hex encoding.
 */
function bufferToNumber(buffer) {
    var string = buffer.toString("hex");
    return parseInt(string, 16);
}

/*
 * Read numBytes bytes (as a Buffer) from our MIDI file.
 */
function readBytes(numBytes) {
    var buf = bytes.slice(byteIndex, byteIndex + numBytes);
    byteIndex += numBytes;
    return buf;
}

/*
 * Read a variable-length MIDI data quantity from the given stream.
 * Variable-length quantities are 1-4 bytes - a 1 in the highest order
 * bit of a read byte determines whether we have more bytes to read.
 * The actual value is determined by the lower 7 bits of each byte put together.
 * Returns an array of the value and the number of bytes read from the stream.
 */
function readVariableLength() {
    var retVal = 0;
    var continueMask = 0x80;
    var valueMask = 0x7F;
    var buf = readBytes(1);
    var byte = bufferToNumber(buf);
    var byteCount = 0;

    // While we still have a 1 in the most significant bit, keep reading
    // Max of 4 bytes
    while ((byte & continueMask) && byteCount < 3) {
        retVal <<= 7;
        retVal |= byte & valueMask;
        var inbuf = readBytes(1);
        byte = bufferToNumber(inbuf);
        byteCount++;
    }

    retVal <<= 7;
    retVal |= byte & valueMask;

    byteCount++;

    return [retVal, byteCount];
}

/*
 * Read a MIDI track from the given stream. Assumes that there is the MTrk
 * chunk at the beginning, the track length, and then a series of events
 * in the stream.
 */
function readTrack(iTrack) {
    var track = readBytes(4);
    if (track != trackChunk) {
        console.error("No track header!");
        return;
    }

    var trackLength = bufferToNumber(readBytes(4));
    var totalDeltaTime = 0;
    tempTrackName = "";
    var trackNameDefault = "Track " + iTrack;
    var trackData = [];

    while (trackLength > 0) {
        var bytesRead = 0;
        var deltaTime = readVariableLength(bytesRead);
        totalDeltaTime += deltaTime[0];
        bytesRead += deltaTime[1];

        var header = readBytes(1);
        var headerByte = bufferToNumber(header);
        bytesRead++;

        if (headerByte == 0xFF) {
            bytesRead += readMetaEvent(trackData, totalDeltaTime);
        }
        else if ((headerByte & 0xF0) == 0xF0) {
            bytesRead += readSysex(trackData, totalDeltaTime, headerByte);
        }
        else {
            bytesRead += readEvent(trackData, totalDeltaTime, headerByte);
        }

        trackLength -= bytesRead;
    }

    if (!tempTrackName) {
        tempTrackName = trackNameDefault;
    }
    outputDict[tempTrackName] = trackData;
}

function readEvent(trackData, totalDeltaTime, headerByte) {
    var bytesRead = 0;
    var status = headerByte;
    var usedRunningStatus = false;
    var firstDataByte = null;

    if (headerByte < 0x80) {
        // If we got a data byte, assume it's running status (ie the same as a previously received event)
        // therefore our "header" is actually our first data byte
        if (runningStatus) {
            firstDataByte = headerByte;
            status = runningStatus;
        }
        else {
            console.error("Unknown event 0x" + headerByte.toString(16) + " and no running status");
            return 0;
        }
    }

    var headerMasked = status & 0xF0;

    // Read our first data byte, if we don't already have it due to running status
    if (firstDataByte === null) {
        firstDataByte = bufferToNumber(readBytes(1));
        bytesRead++;
    }

    if (headerMasked == 0x80) {
        // note off
        var note = firstDataByte;
        var velocity = bufferToNumber(readBytes(1));
        bytesRead++;

        var noteData = { "type" : "noteOff", "time" : totalDeltaTime, "note" : note, "velocity" : velocity };
        trackData.push(noteData);
    }
    else if (headerMasked == 0x90) {
        // note on
        var note = firstDataByte;
        var velocity = bufferToNumber(readBytes(1));
        bytesRead++;

        var noteData = { "type" : "noteOn", "time" : totalDeltaTime, "note" : note, "velocity" : velocity };
        trackData.push(noteData);
    }
    else if (headerMasked == 0xA0) {
        // poly aftertouch
        var note = firstDataByte;
        var pressure = bufferToNumber(readBytes(1));
        bytesRead++;

        var noteData = { "type" : "polyAftertouch", "time" : totalDeltaTime, "note" : note, "pressure" : pressure };
        trackData.push(noteData);
    }
    else if (headerMasked == 0xB0) {
        // CC
        var cc = firstDataByte;
        var value = bufferToNumber(readBytes(1));
        bytesRead++;

        var noteData = { "type" : "CC", "time" : totalDeltaTime, "CC" : cc, "value" : value };
        trackData.push(noteData);
    }
    else if (headerMasked == 0xC0) {
        // program change
        var program = firstDataByte;

        var noteData = { "type" : "programChange", "time" : totalDeltaTime, "program" : program };
        trackData.push(noteData);
    }
    else if (headerMasked == 0xD0) {
        // aftertouch
        var pressure = firstDataByte;

        var noteData = { "type" : "aftertouch", "time" : totalDeltaTime, "pressure" : pressure };
        trackData.push(noteData);
    }
    else if (headerMasked == 0xE0) {
        // pitchwheel
        var lsb = firstDataByte;
        var msb = bufferToNumber(readBytes(1));
        bytesRead++;

        var pitchwheelValue = (msb << 7) | lsb;

        var noteData = { "type" : "pitchwheel", "time" : totalDeltaTime, "pitchwheel" : pitchwheelValue };
        trackData.push(noteData);
    }

    runningStatus = status;

    return bytesRead;
}

function readMetaEvent(trackData, totalDeltaTime) {
    var bytesRead = 0;
    // meta events clear running status
    runningStatus = null;

    // meta event
    var metaHeader = bufferToNumber(readBytes(1));
    bytesRead++;
    var metaLengthRet = readVariableLength();
    var metaLength = metaLengthRet[0];
    bytesRead += metaLengthRet[1];

    if (metaLength > 0) {
        var metaData = readBytes(metaLength);
        var metaValue = bufferToNumber(metaData);
        bytesRead += metaLength;

        if (metaHeader == 0x03) {
            // track/sequence name
            if (metaValue) {
                tempTrackName = metaData.toString("ascii");
            }
        }
        else if (metaHeader == 0x51) {
            // tempo in microseconds per quarter note
            tempo = metaValue;
        }
        else if (metaHeader == 0x58) {
            // time sig
        }
        else {
            // other meta, unsupported
        }
    }
    else {
        if (metaHeader == 0x2F) {
            // track end, has no value
            var trackEndData = { "type" : "trackEnd", "time": totalDeltaTime };
            trackData.push(trackEndData);
        }
    }

    return bytesRead;
}

function readSysex(trackData, totalDeltaTime, headerByte) {
    var bytesRead = 0;

    if (headerByte < 0xF8) {
        // sysex clears running status
        runningStatus = null;
    }
    else {
        // sys real time (doesn't clear running status)
    }

    // read our sysex from the stream, we don't put it in the track data for now
    var length = readVariableLength();
    readBytes(length[0]);
    bytesRead += length[0] + length[1];

    return bytesRead;
}

if (process.argv.length < 4 || process.argv.length > 5) {
    console.error("Usage: node midi2json.js [midi file] [json file] [override tempo in BPM, optional]");
    process.exit(1);
}

if (process.argv.length == 5) {
    // convert beats/min to us/beat
    overrideTempoBPM = parseFloat(process.argv[4]);
    overrideTempo = 60000000.0 / overrideTempoBPM;
}

bytes = fs.readFileSync(process.argv[2]);

var header = readBytes(4);
if (!header) {
    console.error("Failed to read header!");
    process.exit(1);
}
else if (header != headerChunk) {
    console.error("Invalid header! (read " + header.toString() + ", should be MThd)");
    process.exit(1);
}

var headerLength = bufferToNumber(readBytes(4));

var headerVals = [];
for (var i = 0; i < headerLength / 2; i++) {
    var headerVal = readBytes(2);
    headerVals[i] = headerVal;
}

var format = bufferToNumber(headerVals[0]);
console.log("MIDI format: " + format);
var numTracks = bufferToNumber(headerVals[1]);
console.log("Number of tracks: " + numTracks);
division = bufferToNumber(headerVals[2]);
console.log("Time division: " + division);
if (overrideTempo > 0.0) {
    console.log("Override tempo: " + overrideTempoBPM + " BPM");
}

// 1 in the high bit means SMPTE time format
if (division & 0x8000) {
    console.error("SMPTE time format not supported!");
    process.exit(1);
}

for (var iTrack = 0; iTrack < numTracks; iTrack++) {
    readTrack(iTrack);
}

// Figure out how many milliseconds are in each tick:
// tempo is microseconds per quarter note & division is ticks per
// quarter note, so tempo / division = us/tick
if (overrideTempo > 0.0) {
    tempo = overrideTempo;
}
var msPerTick = (tempo / division) / 1000.0;

// Add a helper "timeMS" to each event for event time in milliseconds
for (var track in outputDict) {
    var numEvents = outputDict[track].length;
    for (var i = 0; i < numEvents; i++) {
        var event = outputDict[track][i];
        var time = event["time"];

        if (time !== null) {
            var timeMS = time * msPerTick;
            event["timeMS"] = timeMS;
        }
    }
}

fs.writeFileSync(process.argv[3], JSON.stringify(outputDict, null, 4));

console.log("Done!");
