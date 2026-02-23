import { exec as execCallback } from "child_process";
import { promisify } from "util";
import { v4 as uuidv4 } from 'uuid';

const exec = promisify(execCallback);

// Basic interfaces for tmux objects
export interface TmuxSession {
  id: string;
  name: string;
  attached: boolean;
  windows: number;
}

export interface TmuxWindow {
  id: string;
  name: string;
  active: boolean;
  sessionId: string;
}

export interface TmuxPane {
  id: string;
  windowId: string;
  active: boolean;
  title: string;
}

interface CommandExecution {
  id: string;
  paneId: string;
  command: string;
  status: 'pending' | 'completed' | 'error';
  startTime: Date;
  result?: string;
  exitCode?: number;
}

export type ShellType = 'bash' | 'zsh' | 'fish';

/**
 * Execute a tmux command and return the result
 */
export async function executeTmux(tmuxCommand: string): Promise<string> {
  try {
    const { stdout } = await exec(`tmux ${tmuxCommand}`);
    return stdout.trim();
  } catch (error: any) {
    throw new Error(`Failed to execute tmux command: ${error.message}`);
  }
}

/**
 * Check if tmux server is running
 */
export async function isTmuxRunning(): Promise<boolean> {
  try {
    await executeTmux("list-sessions -F '#{session_name}'");
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * List all tmux sessions
 */
export async function listSessions(): Promise<TmuxSession[]> {
  const format = "#{session_id}:#{session_name}:#{?session_attached,1,0}:#{session_windows}";
  const output = await executeTmux(`list-sessions -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, attached, windows] = line.split(':');
    return {
      id,
      name,
      attached: attached === '1',
      windows: parseInt(windows, 10)
    };
  });
}

/**
 * Find a session by name
 */
export async function findSessionByName(name: string): Promise<TmuxSession | null> {
  try {
    const sessions = await listSessions();
    return sessions.find(session => session.name === name) || null;
  } catch (error) {
    return null;
  }
}

/**
 * List windows in a session
 */
export async function listWindows(sessionId: string): Promise<TmuxWindow[]> {
  const format = "#{window_id}:#{window_name}:#{?window_active,1,0}";
  const output = await executeTmux(`list-windows -t '${sessionId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, name, active] = line.split(':');
    return {
      id,
      name,
      active: active === '1',
      sessionId
    };
  });
}

/**
 * List panes in a window
 */
export async function listPanes(windowId: string): Promise<TmuxPane[]> {
  const format = "#{pane_id}:#{pane_title}:#{?pane_active,1,0}";
  const output = await executeTmux(`list-panes -t '${windowId}' -F '${format}'`);

  if (!output) return [];

  return output.split('\n').map(line => {
    const [id, title, active] = line.split(':');
    return {
      id,
      windowId,
      title: title,
      active: active === '1'
    };
  });
}

/**
 * Capture content from a specific pane, by default the latest 200 lines.
 */
export async function capturePaneContent(paneId: string, lines: number = 200): Promise<string> {
  return executeTmux(`capture-pane -p -t '${paneId}' -S -${lines} -E -`);
}

/**
 * Create a new tmux session
 */
export async function createSession(name: string): Promise<TmuxSession | null> {
  await executeTmux(`new-session -d -s "${name}"`);
  return findSessionByName(name);
}

/**
 * Create a new window in a session
 */
export async function createWindow(sessionId: string, name: string): Promise<TmuxWindow | null> {
  const output = await executeTmux(`new-window -t '${sessionId}' -n '${name}'`);
  const windows = await listWindows(sessionId);
  return windows.find(window => window.name === name) || null;
}

// Map to track ongoing command executions
const activeCommands = new Map<string, CommandExecution>();

// Cache for detected shell types per pane
const paneShellCache = new Map<string, ShellType>();

// Cache for SSH panes that have been initialized with HISTCONTROL
const initializedSSHPanes = new Set<string>();

const startMarkerText = 'TMUX_MCP_START';
const endMarkerPrefix = "TMUX_MCP_DONE_";
const initMarker = 'TMUX_MCP_INIT_DONE';

// Detect shell type for a specific pane
async function detectPaneShell(paneId: string): Promise<ShellType> {
  // Check cache first
  const cached = paneShellCache.get(paneId);
  if (cached) return cached;

  try {
    // Get the current command/process running in the pane
    const output = await executeTmux(`display-message -p -t '${paneId}' '#{pane_current_command}'`);
    const cmd = output.toLowerCase().trim();

    let shellType: ShellType = 'bash'; // default

    if (cmd === 'fish' || cmd.endsWith('/fish')) {
      shellType = 'fish';
    } else if (cmd === 'zsh' || cmd.endsWith('/zsh')) {
      shellType = 'zsh';
    } else if (cmd === 'bash' || cmd.endsWith('/bash')) {
      shellType = 'bash';
    }
    // For ssh or other commands, default to bash (most common on servers)

    paneShellCache.set(paneId, shellType);
    return shellType;
  } catch {
    return 'bash'; // default fallback
  }
}

// Check if pane is running SSH
async function isSSHPane(paneId: string): Promise<boolean> {
  try {
    const output = await executeTmux(`display-message -p -t '${paneId}' '#{pane_current_command}'`);
    const cmd = output.toLowerCase().trim();
    return cmd === 'ssh';
  } catch {
    return false;
  }
}

// Detect remote shell type by executing a command via SSH
async function detectRemoteShell(paneId: string): Promise<ShellType> {
  // Send a command to detect shell type and wait for result
  const detectCmd = ` echo ${initMarker}_SHELL_$0`;
  await executeTmux(`send-keys -t '${paneId}' '${detectCmd}' Enter`);
  
  // Wait for the command to complete
  await new Promise(resolve => setTimeout(resolve, 300));
  
  // Capture pane content and look for the marker
  const content = await capturePaneContent(paneId, 50);
  
  // Parse the shell type from output
  const match = content.match(new RegExp(`${initMarker}_SHELL_(-?\\w+)`));
  if (match) {
    const shell = match[1].toLowerCase().replace(/^-/, ''); // Remove leading dash (login shell)
    if (shell === 'fish' || shell.endsWith('/fish')) {
      return 'fish';
    } else if (shell === 'zsh' || shell.endsWith('/zsh')) {
      return 'zsh';
    }
  }
  return 'bash'; // default
}

// Initialize SSH pane with proper HISTCONTROL setting
async function initializeSSHPane(paneId: string): Promise<ShellType> {
  // Detect remote shell type
  const remoteShellType = await detectRemoteShell(paneId);
  
  // Cache the detected shell type for this pane
  paneShellCache.set(paneId, remoteShellType);
  
  // Set up history control based on remote shell type
  if (remoteShellType === 'bash') {
    // For bash, export HISTCONTROL to ignore commands starting with space
    const initCmd = ` export HISTCONTROL="\${HISTCONTROL:+\$HISTCONTROL:}ignorespace"; echo ${initMarker}`;
    await executeTmux(`send-keys -t '${paneId}' '${initCmd}' Enter`);
    await new Promise(resolve => setTimeout(resolve, 200));
  } else if (remoteShellType === 'zsh') {
    // For zsh, set HIST_IGNORE_SPACE option
    const initCmd = ` setopt HIST_IGNORE_SPACE 2>/dev/null; echo ${initMarker}`;
    await executeTmux(`send-keys -t '${paneId}' '${initCmd}' Enter`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // For fish, leading space is typically enough (configurable via fish_history)
  
  // Mark this pane as initialized
  initializedSSHPanes.add(paneId);
  
  return remoteShellType;
}

// Get end marker text based on shell type
function getEndMarkerForShell(shellType: ShellType): string {
  return shellType === 'fish'
    ? `${endMarkerPrefix}$status`
    : `${endMarkerPrefix}$?`;
}

// Get inline history control prefix based on shell type
// This is prepended to the command in the same line to ensure history ignore is active
function getInlineHistControlPrefix(shellType: ShellType): string {
  switch (shellType) {
    case 'fish':
      // Fish uses leading space with fish_history variable or hist_ignore_space
      // No inline prefix needed; leading space on the full command handles it
      return '';
    case 'zsh':
      // For zsh, set HIST_IGNORE_SPACE inline before the command
      // Using setopt in a subshell doesn't work, so we use fc -p to pause history
      // Actually, leading space works if HIST_IGNORE_SPACE is set in .zshrc
      // For remote servers, we use a more reliable approach: set and execute in same line
      return 'setopt HIST_IGNORE_SPACE 2>/dev/null; ';
    case 'bash':
    default:
      // For bash, set HISTCONTROL inline in the same command line
      // This ensures the setting is active before the command is recorded
      return 'HISTCONTROL=ignorespace; ';
  }
}

// Execute a command in a tmux pane and track its execution
export async function executeCommand(paneId: string, command: string): Promise<string> {
  // Generate unique ID for this command execution
  const commandId = uuidv4();

  // Check if this is an SSH pane that needs initialization
  const isSSH = await isSSHPane(paneId);
  
  let shellType: ShellType;
  
  if (isSSH && !initializedSSHPanes.has(paneId)) {
    // Initialize SSH pane (detects remote shell and sets up HISTCONTROL)
    shellType = await initializeSSHPane(paneId);
  } else {
    // Use cached shell type or detect local shell
    shellType = await detectPaneShell(paneId);
  }
  
  const endMarkerText = getEndMarkerForShell(shellType);

  // Build the full command
  // Leading space prevents command from being recorded in shell history
  // HISTCONTROL/HIST_IGNORE_SPACE has already been set up for SSH panes
  // For local shells, we still include inline prefix as a fallback
  const histControlPrefix = isSSH ? '' : getInlineHistControlPrefix(shellType);
  const fullCommand = ` ${histControlPrefix}echo "${startMarkerText}"; ${command}; echo "${endMarkerText}"`;

  // Store command in tracking map
  activeCommands.set(commandId, {
    id: commandId,
    paneId,
    command,
    status: 'pending',
    startTime: new Date()
  });

  // Send the command to the tmux pane
  await executeTmux(`send-keys -t '${paneId}' '${fullCommand.replace(/'/g, "'\\''")}' Enter`);

  return commandId;
}

export async function checkCommandStatus(commandId: string): Promise<CommandExecution | null> {
  const command = activeCommands.get(commandId);
  if (!command) return null;

  if (command.status !== 'pending') return command;

  const content = await capturePaneContent(command.paneId, 1000);

  // Find the last occurrence of the markers
  const startIndex = content.lastIndexOf(startMarkerText);
  const endIndex = content.lastIndexOf(endMarkerPrefix);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    command.result = "Command output could not be captured properly";
    return command;
  }

  // Extract exit code from the end marker line
  const endLine = content.substring(endIndex).split('\n')[0];
  const endMarkerRegex = new RegExp(`${endMarkerPrefix}(\\d+)`);
  const exitCodeMatch = endLine.match(endMarkerRegex);

  if (exitCodeMatch) {
    const exitCode = parseInt(exitCodeMatch[1], 10);

    command.status = exitCode === 0 ? 'completed' : 'error';
    command.exitCode = exitCode;

    // Extract output between the start and end markers
    const outputStart = startIndex + startMarkerText.length;
    const outputContent = content.substring(outputStart, endIndex).trim();

    command.result = outputContent.substring(outputContent.indexOf('\n') + 1).trim();

    // Update in map
    activeCommands.set(commandId, command);
  }

  return command;
}

// Get command by ID
export function getCommand(commandId: string): CommandExecution | null {
  return activeCommands.get(commandId) || null;
}

// Get all active command IDs
export function getActiveCommandIds(): string[] {
  return Array.from(activeCommands.keys());
}

// Clean up completed commands older than a certain time
export function cleanupOldCommands(maxAgeMinutes: number = 60): void {
  const now = new Date();

  for (const [id, command] of activeCommands.entries()) {
    const ageMinutes = (now.getTime() - command.startTime.getTime()) / (1000 * 60);

    if (command.status !== 'pending' && ageMinutes > maxAgeMinutes) {
      activeCommands.delete(id);
    }
  }
}

