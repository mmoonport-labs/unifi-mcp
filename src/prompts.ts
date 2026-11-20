import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { GUIDE_URI } from './guide.js';

// Ready-made jobs a client can offer as a one-click prompt. Each only reads: it names the steps, and the guide has the details.
const READ_ONLY = `Only read: do not change anything on the gateway. Read the guide (the resource ${GUIDE_URI}, or the prompt unifi_guide) first if you have not, and keep replies small with the fields argument.`;

const user = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

export function registerPrompts(server: McpServer): void {
  server.registerPrompt('network_health_check', {
    title: 'Network health check',
    description: 'Is the internet and the network healthy? Reads health, devices and the WAN, and reports problems.',
  }, () => user([
    'Give me a health check of my UniFi network. ' + READ_ONLY,
    '1. unifi_health: report each subsystem, especially wan and www.',
    '2. unifi_list_devices: any device that is offline, upgradable, or recently restarted.',
    '3. Anything else that stands out. End with a short verdict and a list of what you did not check.',
  ].join('\n')));

  server.registerPrompt('who_is_on_the_network', {
    title: 'Who is on the network',
    description: 'An inventory of connected clients, optionally filtered by a name, IP or MAC.',
    argsSchema: { filter: z.string().optional().describe('A name, IP address or MAC to look for; leave empty for everyone') },
  }, ({ filter }) => user([
    filter === undefined || filter === '' ? 'Who is on my network right now? ' + READ_ONLY : `Is "${filter}" on my network, and what is it connected to? ` + READ_ONLY,
    'Use unifi_list_clients, then legacy_get_clients with fields for the access point, signal and usage when it matters (the guide explains the byte counters). Group the answer by network or access point and flag clients you cannot name.',
  ].join('\n')));

  server.registerPrompt('troubleshoot_client', {
    title: 'Troubleshoot a client',
    description: 'Why is one device slow, offline or misbehaving? Reads its connection, signal, access point and any block.',
    argsSchema: { client: z.string().describe('The device name, IP address or MAC') },
  }, ({ client }) => user([
    `Troubleshoot the client "${client}" on my UniFi network. ${READ_ONLY}`,
    '1. Find it with unifi_list_clients (name, IP or MAC). If it is not connected, check legacy_list_client_config for a block or a fixed IP.',
    '2. For a connected client, legacy_get_clients with fields: wired or Wi-Fi, access point (ap_mac, then its name from legacy_get_devices), signal, band, uptime, and whether it has an IP.',
    '3. Check the access point and the network it is on for obvious problems (legacy_get_rogue_aps for crowded channels). Say what is likely wrong and what the user could try. Do not change anything.',
  ].join('\n')));

  server.registerPrompt('security_review', {
    title: 'Security review',
    description: 'A read-only review of port forwards, Wi-Fi security, VLANs, settings and firewall policies, ranked by severity.',
  }, () => user([
    'Review the security of my UniFi network. ' + READ_ONLY,
    'Follow the "Security review" recipe in the guide: port forwards, Wi-Fi security, VLAN layout, site settings, device firmware and firewall policies. Report findings ranked by severity, say what you could not judge, and list what was not checked (service logins, VPN setup, firmware vulnerabilities).',
  ].join('\n')));
}
