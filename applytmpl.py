#!/usr/bin/env python3

import sys
import glob
import json
import yaml

from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader('./', encoding='utf8'))

if sys.argv[1] == '--json':
    genJSON = True
    tplfile = sys.argv[2]
else:
    genJSON = False
    tplfile = sys.argv[1]


def findsk(org):
    dir = 'crypto-config/peerOrganizations/' + \
        org['domain'] + '/users/Admin@' + org['domain'] + '/msp/keystore'
    return glob.glob(dir + '/*_sk')[0]


env.filters['findsk'] = findsk
tpl = env.get_template(tplfile)

commonDomain = 'example.com'
commonHostname = 'localhost'

data = {
    'network': 'ccperf',
    'ordererorg': {
        'name': 'orderer',
        'mspid': 'OrdererOrg',
        'domain': commonDomain,
        #'type': 'etcdraft',
        #'type': 'kafka',
        'type': 'solo',
        'orderers': [
            {'name': 'orderer1', 'host': commonHostname, 'ports': {'requests': 7050, 'pprof': 7060}},
            #{'name': 'orderer2', 'host': commonHostname, 'ports': {'requests': 7150, 'pprof': 7160}},
        ]
    },
    'orgs': [
        {'name': 'org1',
            'mspid': 'PeerOrg1',
            'domain': 'org1.' + commonDomain,
            'peers': [
                {'name': 'peer1', 'ports': {'requests': 7051,
                                            'pprof': 7061}, 'host': commonHostname},
            ]
         }
    ],
    'zookeepers': [
        #{'id': '1', 'name': 'zookeeper1', 'port': 2181, 'host': commonHostname},
        #{'id': '2', 'name': 'zookeeper2', 'port': 2281, 'host': commonHostname},
        #{'id': '3', 'name': 'zookeeper3', 'port': 2381, 'host': commonHostname},
    ],
    'kafkas': [
        #{'id': '1', 'name': 'kafka1', 'port': 9192, 'host': commonHostname},
        #{'id': '2', 'name': 'kafka2', 'port': 9292, 'host': commonHostname},
        #{'id': '3', 'name': 'kafka3', 'port': 9392, 'host': commonHostname},
    ],
    'grafana': {
        'port': 3000
    },
    'prometheus': {
        'port': 9090
    },
    'pushgateway': {
        'port': 9091
    },
    'proxy': {
        'port': 8888
    }
}

out = tpl.render(data)

if genJSON:
    print(json.dumps(yaml.load(out), indent=4))
else:
    print(out)
