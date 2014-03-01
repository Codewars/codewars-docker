var DockerIO = require('docker.io'),
    poolModule = require('generic-pool'),
    fs = require('fs'),
    net = require('net');


var ConfigureDocker = function(config){

    config.version = config.version || 'v1.8';

    var docker = DockerIO(config.dockerOpts);


    function _makeRunner(runnerConfig) {

        var options = {
            Image: (config.repo+':'+runnerConfig.image),
            AttachStdin: true,
            OpenStdin: true,
            Tty: false,
            Env: ["RUNNER="+runnerConfig.language],
            StdinOnce: true,
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
            var codeStream = fs.createReadStream('test/'+this.language+'/test.'+this.extension);
            this.run(codeStream, finalCB);
        };

        cw.prototype.run = function(codeStream, finalCB) {
            var self = this;
            this.pool.acquire(function(err, job){
                if(err) throw err; 
                job.stdout = '';
                job.stderr = '';
                job.initialTime = Date.now();
                job.finalCB = finalCB;
                job.injectCode(codeStream, function(err, client){job.postInject(err, client);});
            });
        };

        // do not call this directly anymore if using pool
        cw.prototype.createJob = function(finalCB) {

            var defaultCB = function() {
                var result = {
                   statusCode: this.statusCode,
                   stdout: this.stdout,
                   stderr: this.stderr 
                }
                console.log('Job '+this.id+' finished.  No callback provided');
                console.log('Result:\n', result);
            }

            var _cleanup = function() {
                var self = this;
                this.finalCB.call(this);
                this.pool.release(this); // TESTING, will need to test loop in BASH
/*
                this.docker.containers.remove(this.id, function(err){
                    if(err) self.instrument('Remove failed: ', err.message);
                });
*/
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
                this.finalCB = finalCB || defaultCB;
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
                            _setupInject.call(job); // !!!!
                                thisRunner.docker.containers.start(job.id, function(err, result) {
                                   if(err) throw err;
                                   //_setupInject.call(job);
                                   callback(job);
                                });
                            } else callback(new Error('No ID returned from docker create'), null);
                        } else callback(err, null);
                    });

                },
                destroy: function(job) {
                    console.log('DESTROYING '+job.id+' although container may not be removed!')
                },
                refreshIdle: false,
                max: 5, // look for maximum
                min: 3, 
                log: false // can also be a function
            });
        }
        return thisRunner;
    }

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
                /*
                setTimeout(function(){
                    _postInjectHandlerInspect.call(self, null, client);
                }, 500); */
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

    function _setupInject() {
        var self = this;

        var iClient = net.connect(config.dockerOpts.port, config.dockerOpts.hostname);


        // TODO do the other closure here too!
        //_postInjectHandlerReattach.call(this, null, {});

        iClient.on('connect', function() { 
            iClient.write('POST /'+config.version+'/containers/' + self.id + '/attach?stdin=1&stdout=0&stderr=0&stream=1 HTTP/1.1\r\n' + 
                'Content-Type: application/vnd.docker.raw-stream\r\n\r\n');
            iClient.on('data', function(data) { 

                var _injectCode = function(input) {
                    input.pipe(iClient);

                    var _endInject = function() {
                        self.report('client input socket finished');
                        input.unpipe(iClient);
                        iClient.removeAllListeners('finish');
                    };
                    iClient.on('finish', _endInject);
                }
                self.injectCode = _injectCode;

            });

            iClient.on('end', function() {
                self.report('client input socket ended');
                self.injectCode = function(obj){this.report('This function should NOT exist');};
            });

        });

        var oClient = net.connect(config.dockerOpts.port, config.dockerOpts.hostname);

        oClient.on('error', function(err) {
          self.report('stdout/stderr socket error:', err);
        });

        oClient.on('connect', function() { 
            oClient.write('POST /'+config.version+'/containers/' + self.id + '/attach?stdin=0&stdout=1&stderr=1&stream=1 HTTP/1.1\r\n' + 
                'Content-Type: application/vnd.docker.raw-stream\r\n\r\n');
            oClient.on('data', function(data) {
/*
                if(typeof someObject.ok === 'undefined' || !someObject.ok) {
                    someObject.ok = true;
                    return; 
                } */

                self.report('reading stdout on REATTACH: ' + data);
                // Demuxing Stream
                while(data !== null) { // no longer need while loop, see last instruction 
                    var type = data.readUInt8(0);
                    //console.log('type is : '+type);
                    var size = data.readUInt32BE(4);
                    //console.log('size is : '+size);
                    var payload = data.slice(8, size+8);
                    //console.log('payload is: '+payload);
                    if(payload == null) break;
                    if(type == 2) self.stderr += payload;
                    else self.stdout += payload;
                    data = null; // no chunking so far

                    //self.report('calling end manually');
                    //client.end();  
// VERY IMPORTANT, IF CLEANUP IS CALLED ON INITIAL DATA WE RELEASE TO THE POOL!!!
                    self.report('Calling cleanup DIRECTLY on read');
                    //someObject.ok = false; // FIXME (maybe ensure only one socket???)
                    self.cleanup();

                 }
                   // client.end(); 
            });

            oClient.on('end', function() {
                self.report('client socket ended for output');
                //self.cleanup();
            });

            oClient.on('finish', function() {
                self.report('client socket finished for output');
            });
        });

    }

    return { createRunner: _makeRunner }
};

module.exports = ConfigureDocker;
