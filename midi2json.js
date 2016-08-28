/*
 * This script parses a MIDI file and writes the data (currently only note on/note off) to a json file.
 */

var headerChunk = "MThd";
var trackChunk = "MTrk";
// tempo is represented as microseconds per quarter note
// this is 120bpm, which is the default for MIDI with unspecified tempo
var tempo = 500000.0;
var division = 0;
var outputDict = {};
var fs = require('fs');

/*
 * Convert a Buffer into a number, assuming it's using hex encoding.
 */
function bufferToNumber(buffer) {
    var string = buffer.toString("hex");
    return parseInt(string, 16);
}

/*
 * Read a variable-length MIDI data quantity from the given stream.
 * Variable-length quantities are 1-4 bytes - a 1 in the highest order
 * bit of a read byte determines whether we have more bytes to read.
 * The actual value is determined by the lower 7 bits of each byte put together.
 * Returns an array of the value and the number of bytes read from the stream.
 */
function readVariableLength(readStream) {
    var retVal = 0;
    var continueMask = 0x80;
    var valueMask = 0x7F;
    var byte = bufferToNumber(readStream.read(1));
    var byteCount = 0;

    // While we still have a 1 in the most significant bit, keep reading
    // Max of 4 bytes
    while ((byte & continueMask) && byteCount < 3) {
        retVal <<= 7;
        retVal |= byte & valueMask;
        byte = bufferToNumber(readStream.read(1));
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
function readTrack(readStream, iTrack) {
    var track = readStream.read(4);
    if (track != trackChunk) {
        console.error("No track header!");
        return;
    }

    var trackLength = bufferToNumber(readStream.read(4));
    var totalDeltaTime = 0;
    var trackName = "";
    var trackNameDefault = "Track " + iTrack;
    var trackData = [];

    while (trackLength > 0) {
        var bytesRead = 0;
        var deltaTime = readVariableLength(readStream, bytesRead);
        totalDeltaTime += deltaTime[0];
        bytesRead += deltaTime[1];

        var header = readStream.read(1);
        var headerByte = bufferToNumber(header);
        bytesRead++;

        if ((headerByte & 0xF0) == 0x80) {
            // note off
            var note = bufferToNumber(readStream.read(1));
            var velocity = bufferToNumber(readStream.read(1));
            bytesRead += 2;

            var noteData = { "type" : "noteOff", "time" : totalDeltaTime, "note" : note, "velocity" : velocity };
            trackData.push(noteData);
        }
        else if ((headerByte & 0xF0) == 0x90) {
            // note on
            var note = bufferToNumber(readStream.read(1));
            var velocity = bufferToNumber(readStream.read(1));
            bytesRead += 2;

            var noteData = { "type" : "noteOn", "time" : totalDeltaTime, "note" : note, "velocity" : velocity };
            trackData.push(noteData);
        }
        else if (headerByte == 0xFF) {
            // meta event
            var metaHeader = bufferToNumber(readStream.read(1));
            bytesRead++;
            var metaLengthRet = readVariableLength(readStream);
            var metaLength = metaLengthRet[0];
            bytesRead += metaLengthRet[1];

            if (metaLength > 0) {
                var metaData = readStream.read(metaLength);
                var metaValue = bufferToNumber(metaData);
                bytesRead += metaLength;

                if (metaHeader == 0x03) {
                    // track/sequence name
                    if (metaValue) {
                        trackName = metaData.toString("ascii");
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
        }
        else if (headerByte == 0xF0) {
            // sysex?
            var length = readVariableLength(readStream);
            readStream.read(length[0]);
            bytesRead += length[0] + length[1];
        }

        trackLength -= bytesRead;
    }

    if (!trackName) {
        trackName = trackNameDefault;
    }
    outputDict[trackName] = trackData;
}

if (process.argv.length !== 4) {
    console.error("Usage: node midi2json.js [midi file] [json file]");
    process.exit(1);
}

var readStream = fs.createReadStream(process.argv[2]);
readStream.on("readable", function() {
    readStream.setEncoding("ascii");

    var header = readStream.read(4);
    // We can get a readable event at the end, so if we read and got null,
    // that's probably what happened, so we're done
    if (!header) {
        return;
    }
    else if (header != headerChunk) {
        console.error("No header!");
        process.exit(1);
    }

    var headerLength = bufferToNumber(readStream.read(4));

    var headerVals = [];
    for (var i = 0; i < headerLength / 2; i++) {
        var headerVal = readStream.read(2);
        headerVals[i] = headerVal;
    }

    var format = bufferToNumber(headerVals[0]);
    console.log("format: " + format);
    var numTracks = bufferToNumber(headerVals[1]);
    console.log("num tracks: " + numTracks);
    division = bufferToNumber(headerVals[2]);
    console.log("division: " + division);

    // 1 in the high bit means SMPTE time format
    if (division & 0x8000) {
        console.error("SMPTE time format not supported!");
        process.exit(1);
    }

    for (var iTrack = 0; iTrack < numTracks; iTrack++) {
        readTrack(readStream, iTrack);
    }
});

readStream.on("end", function() {
    console.log("Done!");

    // Figure out how many milliseconds are in each tick:
    // tempo is microseconds per quarter note & division is ticks per
    // quarter note, so tempo / division = us/tick
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

    console.log(JSON.stringify(outputDict, null, 4));
});
