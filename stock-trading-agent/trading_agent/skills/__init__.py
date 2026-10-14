from . import equity, market, options, portfolio, strategies, tracking
from .base import Skill, SkillContext, SkillRegistry, auto_approve, confirm_all, confirm_none, deny_all


def default_registry() -> SkillRegistry:
    reg = SkillRegistry()
    for module in (market, portfolio, equity, options, strategies, tracking):
        module.register(reg)
    return reg


__all__ = ["Skill", "SkillContext", "SkillRegistry", "auto_approve", "confirm_all", "confirm_none", "deny_all",
           "default_registry"]
