'use strict';

var cluster = require('cluster');
var os = require('os');
var util = require('util');
var utility = require('utility');

var defer = global.setImmediate || process.nextTick;

module.exports = fork;

/**
 * cluster fork
 *
 * @param {Object} [options]
 *   - {String} exec       exec file path 文件路径
 *   - {Array} [args]      exec arguments
 *   - {Array} [slaves]    slave processes
 *   - {Boolean} [silent]  whether or not to send output to parent's stdio, default is `false`
 *   - {Number} [count]    worker num, defualt is `os.cpus().length`
 *   - {Boolean} [refork]  refork when disconect and unexpected exit, default is `true`
 *   - {Boolean} [autoCoverage] auto fork with istanbul when `running_under_istanbul` env set, default is `false`
 * @return {Cluster}
 */

function fork(options) {
  // 如果是 worker 子进程
  if (cluster.isWorker) {
    return;
  }

  options = options || {};
  var count = options.count || os.cpus().length;
  var refork = options.refork !== false;
  var limit = options.limit || 60;
  var duration = options.duration || 60000; // 1 min
  var reforks = [];
  var attachedEnv = options.env || {};
  var newWorker;

  if (options.exec) {
    var opts = {
      exec: options.exec
    };

    if (options.execArgv !== undefined) {
      opts.execArgv = options.execArgv;
    }

    if (options.args !== undefined) {
      opts.args = options.args;
    }
    if (options.silent !== undefined) {
      opts.silent = options.silent;
    }

    // https://github.com/gotwarlost/istanbul#multiple-process-usage
    // Multiple Process under istanbul
    if (options.autoCoverage && process.env.running_under_istanbul) {
      // use coverage for forked process
      // disabled reporting and output for child process
      // enable pid in child process coverage filename
      var args = [
        'cover', '--report', 'none', '--print', 'none', '--include-pid',
        opts.exec,
      ];
      if (opts.args && opts.args.length > 0) {
        args.push('--');
        args = args.concat(opts.args);
      }

      opts.exec = './node_modules/.bin/istanbul';
      opts.args = args;
    }

    // 用于修改默认'fork' 行为，一旦调用，将会按照 cluster.settings 进行设置，只能由主进程调用
    cluster.setupMaster(opts);
  }

  var disconnects = {};
  var disconnectCount = 0;
  var unexpectedCount = 0;

  // 在工作进程的 IPC 管道被断开后触发本事件
  cluster.on('disconnect', function (worker) {
    var log = console[worker.disableRefork ? 'info' : 'error'];
    disconnectCount++;
    // 当工作进程被终止时（包括自动退出或被发送信号），这个方法返回 true，否则返回 false
    var isDead = worker.isDead && worker.isDead();
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    log('[%s] [cfork:master:%s] worker:%s disconnect (%s: %s, state: %s, isDead: %s, worker.disableRefork: %s)',
      utility.logDate(), process.pid, worker.process.pid, propertyName, worker[propertyName],
      worker.state, isDead, worker.disableRefork);
    if (isDead) {
      // worker has terminated before disconnect
      log('[%s] [cfork:master:%s] don\'t fork, because worker:%s exit event emit before disconnect',
        utility.logDate(), process.pid, worker.process.pid);
      return;
    }
    if (worker.disableRefork) {
      // worker has terminated by master, like egg-cluster master will set disableRefork to true
      log('[%s] [cfork:master:%s] don\'t fork, because worker:%s will be kill soon',
        utility.logDate(), process.pid, worker.process.pid);
      return;
    }

    disconnects[worker.process.pid] = utility.logDate();
    if (allow()) {
      newWorker = forkWorker(worker._clusterSettings);
      newWorker._clusterSettings = worker._clusterSettings;
      log('[%s] [cfork:master:%s] new worker:%s fork (state: %s)',
        utility.logDate(), process.pid, newWorker.process.pid, newWorker.state);
    } else {
      log('[%s] [cfork:master:%s] don\'t fork new work (refork: %s)',
        utility.logDate(), process.pid, refork);
    }
  });

  // 当任何一个工作进程关闭的时候，cluster 模块都将触发 exit 事件
  cluster.on('exit', function (worker, code, signal) {
    var log = console[worker.disableRefork ? 'info' : 'error'];
    var isExpected = !!disconnects[worker.process.pid];
    var isDead = worker.isDead && worker.isDead();
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    log('[%s] [cfork:master:%s] worker:%s exit (code: %s, %s: %s, state: %s, isDead: %s, isExpected: %s, worker.disableRefork: %s)',
      utility.logDate(), process.pid, worker.process.pid, code, propertyName, worker[propertyName],
      worker.state, isDead, isExpected, worker.disableRefork);
    if (isExpected) {
      delete disconnects[worker.process.pid];
      // worker disconnect first, exit expected
      return;
    }
    if (worker.disableRefork) {
      // worker is killed by master
      return;
    }

    unexpectedCount++;
    if (allow()) {
      newWorker = forkWorker(worker._clusterSettings);
      newWorker._clusterSettings = worker._clusterSettings;
      log('[%s] [cfork:master:%s] new worker:%s fork (state: %s)',
        utility.logDate(), process.pid, newWorker.process.pid, newWorker.state);
    } else {
      log('[%s] [cfork:master:%s] don\'t fork new work (refork: %s)',
        utility.logDate(), process.pid, refork);
    }
    cluster.emit('unexpectedExit', worker, code, signal);
  });

  // defer to set the listeners
  // so you can listen this by your own
  defer(function () {
    if (process.listeners('uncaughtException').length === 0) {
      process.on('uncaughtException', onerror);
    }
    if (cluster.listeners('unexpectedExit').length === 0) {
      cluster.on('unexpectedExit', onUnexpected);
    }
    if (cluster.listeners('reachReforkLimit').length === 0) {
      cluster.on('reachReforkLimit', onReachReforkLimit);
    }
  });

  for (var i = 0; i < count; i++) {
    newWorker = forkWorker();
    newWorker._clusterSettings = cluster.settings;
  }

  // fork slaves after workers are forked
  if (options.slaves) {
    var slaves = Array.isArray(options.slaves) ? options.slaves : [options.slaves];
    slaves.map(normalizeSlaveConfig)
      .forEach(function(settings) {
        if (settings) {
          newWorker = forkWorker(settings);
          newWorker._clusterSettings = settings;
        }
      });
  }

  return cluster;

  /**
   * allow refork 控制重启的次数
   */
  function allow() {
    if (!refork) {
      return false;
    }

    var times = reforks.push(Date.now());

    if (times > limit) {
      reforks.shift();
    }

    var span = reforks[reforks.length - 1] - reforks[0];
    var canFork = reforks.length < limit || span > duration;

    if (!canFork) {
      cluster.emit('reachReforkLimit');
    }

    return canFork;
  }

  /**
   * uncaughtException default handler 打印错误日志
   */

  function onerror(err) {
    if (!err) {
      return;
    }
    console.error('[%s] [cfork:master:%s] master uncaughtException: %s', utility.logDate(), process.pid, err.stack);
    console.error(err);
    console.error('(total %d disconnect, %d unexpected exit)', disconnectCount, unexpectedCount);
  }

  /**
   * unexpectedExit default handler
   */

  function onUnexpected(worker, code, signal) {
    var exitCode = worker.process.exitCode;
    // 当调用 .kill() 或者 .disconnect() 方法时被设置，在这之前都是 undefined；suicide 已经被废弃；返回 boolean 类型
    var propertyName = worker.hasOwnProperty('exitedAfterDisconnect') ? 'exitedAfterDisconnect' : 'suicide';
    var err = new Error(util.format('worker:%s died unexpected (code: %s, signal: %s, %s: %s, state: %s)',
      worker.process.pid, exitCode, signal, propertyName, worker[propertyName], worker.state));
    err.name = 'WorkerDiedUnexpectedError';

    console.error('[%s] [cfork:master:%s] (total %d disconnect, %d unexpected exit) %s',
      utility.logDate(), process.pid, disconnectCount, unexpectedCount, err.stack);
  }

  /**
   * reachReforkLimit default handler
   */

  function onReachReforkLimit() {
    console.error('[%s] [cfork:master:%s] worker died too fast (total %d disconnect, %d unexpected exit)',
      utility.logDate(), process.pid, disconnectCount, unexpectedCount);
  }

  /**
   * normalize slave config 规范化 slave 进程配置
   */
  function normalizeSlaveConfig(opt) {
    // exec path
    if (typeof opt === 'string') {
      opt = { exec: opt };
    }
    if (!opt.exec) {
      return null;
    } else {
      return opt;
    }
  }

  /**
   * fork worker with certain settings
   */
  function forkWorker(settings) {
    if (settings) {
      cluster.settings = settings;
      cluster.setupMaster();
    }
    // attachedEnv：增加进程环境变量，以 Key/value 对的形式
    return cluster.fork(attachedEnv);
  }
}
