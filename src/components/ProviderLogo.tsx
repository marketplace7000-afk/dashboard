import ClaudeColor from '@lobehub/icons/es/Claude/components/Color';
import OpenAIMono from '@lobehub/icons/es/OpenAI/components/Mono';
import GeminiColor from '@lobehub/icons/es/Gemini/components/Color';
import MistralColor from '@lobehub/icons/es/Mistral/components/Color';
import DeepSeekColor from '@lobehub/icons/es/DeepSeek/components/Color';
import YandexMono from '@lobehub/icons/es/Yandex/components/Mono';
import GrokMono from '@lobehub/icons/es/Grok/components/Mono';
import PerplexityColor from '@lobehub/icons/es/Perplexity/components/Color';
import type { AgentProvider } from '../mock';

const MAP: Record<AgentProvider, any> = {
  claude: ClaudeColor,
  openai: OpenAIMono,
  gemini: GeminiColor,
  mistral: MistralColor,
  deepseek: DeepSeekColor,
  yandex: YandexMono,
  grok: GrokMono,
  perplexity: PerplexityColor,
};

export const PROVIDER_LABEL: Record<AgentProvider, string> = {
  claude: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  mistral: 'Mistral AI',
  deepseek: 'DeepSeek',
  yandex: 'Yandex',
  grok: 'xAI',
  perplexity: 'Perplexity',
};

export function ProviderLogo({ provider, size = 24 }: { provider: AgentProvider; size?: number }) {
  const I = MAP[provider];
  return <I size={size} />;
}
