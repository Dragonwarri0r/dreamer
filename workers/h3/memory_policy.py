"""User-selected swap-friendly policy; observe pressure instead of guessing capacity."""
import os

def memory_policy():
    policy=os.environ.get('DREAMER_H3_MEMORY_POLICY','swap-friendly')
    if policy not in ['swap-friendly','strict']: raise ValueError('Unknown H3 memory policy')
    return policy

def launch_flags():
    return ['--skip-mem-preflight'] if memory_policy()=='swap-friendly' else []

def resource_stop(sample,critical_samples):
    # Swap growth alone is expected, not an error. Only sustained critical
    # pressure (12 x 5 s) or lack of disk reserve stops the owned job.
    critical_samples=critical_samples+1 if sample.get('pressure')=='4' else 0
    reason='DISK_RESERVE' if sample['diskFreeBytes']<2*1024**3 else 'SUSTAINED_CRITICAL_PRESSURE' if critical_samples>=12 else None
    return critical_samples,reason
