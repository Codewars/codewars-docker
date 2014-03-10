/* We had a ready setup where did setupInject on create and then after every attach
*  Now for debugging we are doing setupInject just before attach
*/ 
var DockerIO = require('docker.io'),
    poolModule = require('generic-pool'),
    streams = require('stream'),
    streamBuffers = require('stream-buffers'),
    fs = require('fs'),
    net = require('net');


var ConfigureDocker = function(config){

    // FIXME
    //config.version = config.version || 'v1.10';
    config.version = config.version || 'v1.8';

    var docker = DockerIO(config.dockerOpts);


    function _makeRunner(runnerConfig) {

        var options = {
            Image: (config.repo+':'+runnerConfig.image),
            AttachStdin: true,
            AttachStdout: true,
            AttachStderr: true,
            OpenStdin: true,
            Tty: false,
            Env: ["RUNNER="+runnerConfig.language],
            StdinOnce: false,
            Cmd: runnerConfig.cmd
        };

        // Prototype chain is such that job shares all functionality
        var cw = function() {
            this.docker = docker;
            //this.injectCode = _injectCode; // try closing over client
            //this.postInject = _postInjectHandlerReattach;
            this.postInject = function() { this.report('fake postInject callback, SHOULD NOT BE CALLED'); };
            //this.postInject = function() { this.cleanup.call(this);};
        };
        // sets language/cmd/etc
        cw.prototype = runnerConfig; 
        cw.prototype.runOpts = options;

        cw.prototype.test = function(finalCB) {
            var runnerThis = this;
            var testFilePath = 'test/'+this.language+'/test.'+this.extension;
            var codeStream = fs.createReadStream(testFilePath);
            fs.stat(testFilePath, function(err, stat) {
                if(err) throw err;
                codeStream.inputSize = stat.size; 
                runnerThis.run(codeStream, finalCB);
                //_setupOutput.call(job, {});
            });
        };

        cw.prototype.run = function(codeStream, cfinalCB) {
            this.pool.acquire(function(err, job){
                if(err) throw err; 
                job.stdout = '';
                job.stderr = '';
                job.initialTime = Date.now();
                if(typeof job.replied !== 'undefined') {
                   console.log('replied WAS: '+job.replied); 
                }
                job.replied = false;
                job.finalCB = cfinalCB;
                _setupInject.call(job, codeStream);
            });
        };

        // do not call this directly anymore if using pool
        cw.prototype.createJob = function() {

            var defaultCB = function() {
                var result = {
                   statusCode: this.statusCode,
                   stdout: this.stdout,
                   stderr: this.stderr 
                }
                console.log('Job '+this.id+' finished.  No callback provided');
                console.log('Result:\n', result);
            }

            // TODO verify clean/dirty state conditions
            var _cleanup = function() {
                this.finalCB.call(this);
                this.report('releasing container...');
                this.pool.release(this); 
            };

            var _instrument = function(optMessage) {
                var id = !!this.id ? this.id.substring(0,13) : 'NONE';

                if(!!this.initialTime) {
                    this.curTime = this.curTime || this.initialTime;
                    var now = Date.now();
                    console.log('job '+id+': total='+(now-this.initialTime)+' block='+(now-this.curTime), optMessage); 
                    this.curTime = now; 
                } else console.log('job '+id+': ', optMessage);
            }

            var _report = function(optMessage) {
                var id = !!this.id ? this.id.substring(0,13) : 'NONE';
                console.log('job '+id+': ', optMessage);
            }

            var job = function(){
                this.id = undefined;
                this.stdout = '';
                this.stderr = '';
                this.statusCode = undefined;
                this.duration = null;
                this.initialTime = undefined;
                this.curTime = undefined;
                this.finalCB = defaultCB;
                this.instrument = _instrument;
                this.report = _report;
                this.cleanup = _cleanup; // out of order now
            }
            job.prototype = this;
            
            return new job();
        }

        var thisRunner = new cw();
        if(!!runnerConfig.pool) {
            thisRunner.pool = poolModule.Pool({
                name: 'docker-' + thisRunner.image + '-pool',
                create: function(callback) {
                    var job = thisRunner.createJob();
                    thisRunner.docker.containers.create(thisRunner.runOpts, function(err, res) {
                        if(!err) {
                            if(!!res.Id) {
                                job.id = res.Id;
                                thisRunner.docker.containers.start(job.id, function(err, result) {
                                   if(err) throw err;
                                   //_setupInject.call(job);
                                   //_setupOutput.call(job, {});
                                   callback(job);
                                });
                            } else callback(new Error('No ID returned from docker create'), null);
                        } else callback(err, null);
                    });

                },
                destroy: function(job) {
                    console.log('DESTROYING '+job.id+' although container may not be removed!')
                },
                idleTimeoutMillis: 9000000,
                refreshIdle: false,
                max: 60,
                min: 40, 
                log: true // can also be a function
            });
        }
        return thisRunner;
    }

/*
    // After we encounter this, we may want to release the job 
    // back into the pool instead of destroying it - depends on use case
    function _postInjectHandlerInspect(err, client) {
        if(err) throw err;

        var self = this;
        this.instrument('inject completed, calling inspect directly');
        this.docker.containers.inspect(this.id, function(err, details) {
            if(err) throw err;
            self.instrument('inspect returned');

            if(!!details.State.Running) {
                self.report('Inspect after finish returned running!');
                // is this wise under load?
                self.postInject(null, client);
                return;
            }

            if(!details.State.StartedAt || !details.State.FinishedAt)  {
                self.report("cannot get duration of a container without start/finish");
            } else {
                var ss = new Date(details.State.StartedAt).getTime();
                var ff = new Date(details.State.FinishedAt).getTime();
                self.duration = (ff-ss);
            }
            self.statusCode = details.StatusCode;
            self.cleanup();
        }); 
    }

    function _postInjectHandlerWait(err, client) {
        if(err) throw err;

        var self = this;
        this.instrument('inject completed, about to wait container');
           self.docker.containers.wait(self.id, function(err, data) {
               if(err) throw err;
               self.instrument('Container returned from wait with statusCode', data.statusCode);
               self.statusCode = data.StatusCode;
                   // do logs in finalCB, cleanup after res.send
               self.cleanup();
           });
    }

    function _postInjectHandlerStart(err, client) {
        if(err) throw err;

        var self = this;
        this.instrument('inject completed, about to start container');
        this.docker.containers.start(self.id, function(err, result) {
           if(err) throw err;
           self.instrument('Container started, about to wait!!!');

           self.docker.containers.wait(self.id, function(err, data) {
               if(err) throw err;
               self.instrument('Container returned from wait with statusCode', data.statusCode);
               self.statusCode = data.StatusCode;
                   // do logs in finalCB, cleanup after res.send
               self.cleanup();
           });
        });
    }
*/

    // outputOnly is for the repeated attempts to grab stdout
    // Make this a regular job function which resets self.client if necessary
    // this will allow us to share functions
    function _setupInject(codeStream, outputOnly) {
        var outputOnly = outputOnly || false;
        var self = this;

        var client = net.connect(config.dockerOpts.port, config.dockerOpts.hostname);

        client.on('connect', function() { 
            var sin, sout, serr;
            sin = outputOnly ? '0' : '1';
            sout = serr = '1';
            client.write('POST /'+config.version+'/containers/' + self.id + '/attach?stdin='+sin+'&stdout='+sout+'&stderr='+serr+'&stream=1 HTTP/1.1\r\n' +
                'Content-Type: application/vnd.docker.raw-stream\r\n\r\n');

            client.on('error', function(err) {
               self.report('error on socket: ', err);
               // cb(err);
            });

            // change codeStream to (eventually) self.client.hasConnected and self.client.hasReplied - or a STATE VARIABLE
            client.on('data', function(data) { 
                if(typeof codeStream.spent === 'undefined' || !codeStream.spent) {
                    self.report('received initial socket data: ' + data);
                    if(outputOnly) {
                        codeStream.spent = true;
                        codeStream.waiting = true;
                        // holy shit
                        setTimeout(function(){
                            client.end();
                            _setupInject.call(self, {}, true);
                        }, 2000); // change this?
                        return; 
                    }
                    self.report('injecting code');
                    codeStream.pipe(client);
                } else {
                    self.report('data received on output\n' + data);
                    codeStream.waiting = false;
                    while(data !== null) { // no longer need while loop, see last instruction 
                        self.replied = true;
                        var payload;
                        if(self.runOpts.Tty) {
                            payload = data.slice(); // ???
                            self.report('payload type: ' + (typeof payload));
                            self.stdout += payload;
                        } else {
                            var type = data.readUInt8(0);
                            //self.report('type is : '+type);
                            var size = data.readUInt32BE(4);
                            self.report('data size is : '+data.length);
                            self.report('size is : '+size);
                            payload = data.slice(8, size+8);
                            //self.report('payload is: '+payload);
                            if(payload == null) break;
                            if(type == 2) self.stderr += payload;
                            else if(type == 1) self.stdout += payload;
                            else self.report('Problem with streaming API - check version in config!\nDiscarding...');
                        }
                        data = null; // not concerned with chunking or logs yet.
                    }
                    self.report('destroying socket and cleanup...');
                    client.end(); // see if this calls finish?
                    self.cleanup();
                }
            });

            // code has been injected
            client.on('finish', function() {
                self.report('client socket finished');
                codeStream.spent = true;
                if(outputOnly) {
                    client.destroy();
                    delete client;
                } else codeStream.unpipe(client);
            });

            // Verify this is ended, look into any necessary cleanup
            // maybe this is causing destroy to be called more than once?!
            client.on('end', function() {
                self.report('client socket ended');
                if(!self.replied) {
                  client.destroy();
                  delete client;
                  _setupInject.call(self, {}, true);
                } // else self.cleanup(); // move this back into callback
            });
        });
    }
    return { createRunner: _makeRunner }
};

module.exports = ConfigureDocker;
